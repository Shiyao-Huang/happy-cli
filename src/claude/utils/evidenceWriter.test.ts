import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeEntityVerdict } from './evidenceWriter';
import { createEntityVerdict, ensureEntityTrial } from './entityHub';

vi.mock('./entityHub', () => ({
    ensureEntityTrial: vi.fn(),
    createEntityVerdict: vi.fn(),
}));

type MockResponse = {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
};

function jsonResponse(status: number, payload: unknown): MockResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return payload;
        },
    };
}

describe('writeEntityVerdict', () => {
    const ensureEntityTrialMock = vi.mocked(ensureEntityTrial);
    const createEntityVerdictMock = vi.mocked(createEntityVerdict);

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('writes directly to genome-hub when direct transport succeeds', async () => {
        ensureEntityTrialMock.mockResolvedValue({ trial: { id: 'trial-direct' } });
        createEntityVerdictMock.mockResolvedValue({ verdict: { id: 'verdict-direct' } });

        const result = await writeEntityVerdict({
            namespace: '@official',
            name: 'implementer',
            readerRole: 'supervisor',
            content: 'keep',
            score: 88,
        });

        expect(result).toEqual({
            trialId: 'trial-direct',
            verdictId: 'verdict-direct',
            transport: 'direct-hub',
        });
        expect(ensureEntityTrialMock).toHaveBeenCalledOnce();
        expect(createEntityVerdictMock).toHaveBeenCalledOnce();
    });

    it('falls back to the server proxy when direct hub write fails', async () => {
        ensureEntityTrialMock.mockRejectedValue(new Error('hub unavailable'));

        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(200, { entity: { id: 'entity-1' } }))
            .mockResolvedValueOnce(jsonResponse(200, {
                trials: [{ id: 'trial-open', sessionId: 'session-1', endedAt: null }],
            }))
            .mockResolvedValueOnce(jsonResponse(201, { verdict: { id: 'verdict-proxy' } }));

        const result = await writeEntityVerdict({
            namespace: '@official',
            name: 'implementer',
            sessionId: 'session-1',
            readerRole: 'supervisor',
            readerSessionId: 'supervisor-session',
            content: 'keep',
            score: 91,
            serverUrl: 'https://aha.example.com/api',
            authToken: 'user-token',
            fetchImpl: fetchMock,
        });

        expect(result).toEqual({
            trialId: 'trial-open',
            verdictId: 'verdict-proxy',
            transport: 'server-proxy',
        });
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            'https://aha.example.com/v1/entities/%40official/implementer',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer user-token',
                }),
            }),
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            'https://aha.example.com/v1/entities/id/entity-1/trials',
            expect.any(Object),
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            'https://aha.example.com/v1/trials/trial-open/verdicts',
            expect.objectContaining({
                method: 'POST',
            }),
        );
    });

    it('creates a proxy trial when no open session trial exists', async () => {
        ensureEntityTrialMock.mockRejectedValue(new Error('hub unavailable'));

        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(200, { entity: { id: 'entity-1' } }))
            .mockResolvedValueOnce(jsonResponse(200, { trials: [] }))
            .mockResolvedValueOnce(jsonResponse(201, { trial: { id: 'trial-created' } }))
            .mockResolvedValueOnce(jsonResponse(201, { verdict: { id: 'verdict-created' } }));

        const result = await writeEntityVerdict({
            namespace: '@official',
            name: 'implementer',
            teamId: 'team-1',
            sessionId: 'session-2',
            contextNarrative: 'score_agent verdict',
            logRefs: JSON.stringify([{ kind: 'aha-session', sessionId: 'session-2', runtimeType: 'claude' }]),
            readerRole: 'supervisor',
            content: 'mutate',
            action: 'mutate',
            serverUrl: 'https://aha.example.com',
            authToken: 'user-token',
            fetchImpl: fetchMock,
        });

        expect(result).toEqual({
            trialId: 'trial-created',
            verdictId: 'verdict-created',
            transport: 'server-proxy',
        });
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            'https://aha.example.com/v1/entities/%40official/implementer/trials',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    teamId: 'team-1',
                    sessionId: 'session-2',
                    contextNarrative: 'score_agent verdict',
                    logRefs: [{ kind: 'aha-session', sessionId: 'session-2', runtimeType: 'claude' }],
                }),
            }),
        );
    });
});
