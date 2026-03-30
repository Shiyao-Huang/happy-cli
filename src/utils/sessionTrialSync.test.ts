import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    buildSessionTrialLogRefs,
    closeSessionTrial,
    ensureSessionTrial,
    findSessionTrial,
    type TrialRecord,
} from './sessionTrialSync';

const fetchMock = vi.fn();

const mapping = {
    sessionId: 'aha-session-1',
    teamId: 'team-1',
    specId: 'spec-1',
    specRef: '@official/implementer:7',
    specVersion: 7,
    runtimeType: 'claude',
    startedAt: 123,
    claudeSessionId: 'claude-local-1',
} as const;

function jsonResponse(body: unknown, ok = true) {
    return {
        ok,
        json: vi.fn().mockResolvedValue(body),
    };
}

describe('sessionTrialSync', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        fetchMock.mockReset();
    });

    it('builds log refs from runtime session identifiers', () => {
        expect(JSON.parse(buildSessionTrialLogRefs({
            ...mapping,
            codexRolloutId: 'codex-rollout-1',
        }))).toEqual([
            { kind: 'aha-session', sessionId: 'aha-session-1', runtimeType: 'claude' },
            { kind: 'claude-session', sessionId: 'claude-local-1' },
            { kind: 'codex-rollout', sessionId: 'codex-rollout-1' },
        ]);
    });

    it('creates a trial when the session does not have one yet', async () => {
        vi.stubGlobal('fetch', fetchMock);
        const createdTrial: TrialRecord = {
            id: 'trial-1',
            hubEntityId: 'spec-1',
            entityVersion: 7,
            teamId: 'team-1',
            sessionId: 'aha-session-1',
            contextNarrative: null,
            logRefs: '[]',
            startedAt: '2026-03-29T00:00:00.000Z',
            endedAt: null,
        };

        fetchMock
            .mockResolvedValueOnce(jsonResponse({ trials: [] }))
            .mockResolvedValueOnce(jsonResponse({ trial: createdTrial }));

        const result = await ensureSessionTrial({
            serverUrl: 'http://localhost:3005',
            authToken: 'token-1',
            mapping,
        });

        expect(result).toEqual(createdTrial);
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            'http://localhost:3005/v1/trials',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-1',
                }),
            }),
        );
    });

    it('reuses an existing trial when one already exists for the session', async () => {
        vi.stubGlobal('fetch', fetchMock);
        const existingTrial: TrialRecord = {
            id: 'trial-2',
            hubEntityId: 'spec-1',
            entityVersion: 7,
            teamId: 'team-1',
            sessionId: 'aha-session-1',
            contextNarrative: null,
            logRefs: '[]',
            startedAt: '2026-03-29T00:00:00.000Z',
            endedAt: null,
        };
        fetchMock.mockResolvedValueOnce(jsonResponse({ trials: [existingTrial] }));

        const result = await ensureSessionTrial({
            serverUrl: 'http://localhost:3005',
            authToken: 'token-1',
            mapping,
        });

        expect(result).toEqual(existingTrial);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent ensureSessionTrial calls for the same session', async () => {
        vi.stubGlobal('fetch', fetchMock);
        const createdTrial: TrialRecord = {
            id: 'trial-2b',
            hubEntityId: 'spec-1',
            entityVersion: 7,
            teamId: 'team-1',
            sessionId: 'aha-session-1',
            contextNarrative: null,
            logRefs: '[]',
            startedAt: '2026-03-29T00:00:00.000Z',
            endedAt: null,
        };

        fetchMock
            .mockResolvedValueOnce(jsonResponse({ trials: [] }))
            .mockResolvedValueOnce(jsonResponse({ trial: createdTrial }));

        const [first, second] = await Promise.all([
            ensureSessionTrial({
                serverUrl: 'http://localhost:3005',
                authToken: 'token-1',
                mapping,
            }),
            ensureSessionTrial({
                serverUrl: 'http://localhost:3005',
                authToken: 'token-1',
                mapping,
            }),
        ]);

        expect(first).toEqual(createdTrial);
        expect(second).toEqual(createdTrial);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('closes the existing trial with endedAt and log refs', async () => {
        vi.stubGlobal('fetch', fetchMock);
        const existingTrial: TrialRecord = {
            id: 'trial-3',
            hubEntityId: 'spec-1',
            entityVersion: 7,
            teamId: 'team-1',
            sessionId: 'aha-session-1',
            contextNarrative: null,
            logRefs: '[]',
            startedAt: '2026-03-29T00:00:00.000Z',
            endedAt: null,
        };
        const patchedTrial: TrialRecord = {
            ...existingTrial,
            endedAt: '2026-03-29T00:05:00.000Z',
        };
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ trials: [existingTrial] }))
            .mockResolvedValueOnce(jsonResponse({ trial: patchedTrial }));

        const result = await closeSessionTrial({
            serverUrl: 'http://localhost:3005',
            authToken: 'token-1',
            sessionId: 'aha-session-1',
            endedAt: '2026-03-29T00:05:00.000Z',
            logRefs: buildSessionTrialLogRefs(mapping),
        });

        expect(result).toEqual(patchedTrial);
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            'http://localhost:3005/v1/trials/trial-3',
            expect.objectContaining({
                method: 'PATCH',
                body: expect.stringContaining('2026-03-29T00:05:00.000Z'),
            }),
        );
    });

    it('finds an existing trial by session id', async () => {
        vi.stubGlobal('fetch', fetchMock);
        const existingTrial: TrialRecord = {
            id: 'trial-4',
            hubEntityId: 'spec-1',
            entityVersion: 7,
            teamId: 'team-1',
            sessionId: 'aha-session-1',
            contextNarrative: null,
            logRefs: '[]',
            startedAt: '2026-03-29T00:00:00.000Z',
            endedAt: null,
        };
        fetchMock.mockResolvedValueOnce(jsonResponse({ trials: [existingTrial] }));

        const result = await findSessionTrial({
            serverUrl: 'http://localhost:3005',
            authToken: 'token-1',
            sessionId: 'aha-session-1',
        });

        expect(result).toEqual(existingTrial);
    });
});
