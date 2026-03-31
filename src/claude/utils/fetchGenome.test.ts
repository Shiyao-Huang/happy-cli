import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAxiosGet = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
    debug: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: mockAxiosGet,
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: mockLogger,
}));

import {
    fetchAgentImage,
    fetchAgentImageSeed,
    fetchAgentPlugLedger,
    fetchAgentVerdictData,
    resolveEntityUrl,
} from './fetchGenome';

/**
 * T-002: redefine 分支只解析 canonical entity URL
 *
 * 直接测试导出的 resolveEntityUrl。
 */
describe('fetchAgentImage resolveEntityUrl', () => {
    beforeEach(() => {
        mockAxiosGet.mockReset();
        mockLogger.debug.mockReset();
    });

    it('UUID format → /entities/id/:id', () => {
        const url = resolveEntityUrl('abc-123-def');
        expect(url).toContain('/entities/id/abc-123-def');
    });

    it('@ns/name → /entities/:encodedNs/:name', () => {
        const url = resolveEntityUrl('@official/supervisor');
        expect(url).toContain('/entities/%40official/supervisor');
        expect(url).not.toContain('/latest');
    });

    it('@ns/name:version → /entities/:encodedNs/:name/:version', () => {
        const url = resolveEntityUrl('@official/supervisor:2');
        expect(url).toContain('/entities/%40official/supervisor/2');
    });

    it('base URL comes from configuration resolver path shape', () => {
        const url = resolveEntityUrl('@myteam/worker:10');
        expect(url).toContain('/entities/%40myteam/worker/10');
    });

    it('returns null for feedbackData only on 404', async () => {
        mockAxiosGet.mockResolvedValueOnce({
            status: 404,
            data: {},
        });

        await expect(fetchAgentVerdictData('token', '@official/supervisor')).resolves.toBeNull();
    });

    it('throws feedbackData network errors instead of silently returning null', async () => {
        const error = new Error('network down');
        mockAxiosGet.mockRejectedValueOnce(error);

        await expect(fetchAgentVerdictData('token', '@official/supervisor:99')).rejects.toThrow('network down');
        expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch feedbackData'));
    });

    it('returns null for missing entity specs only on 404', async () => {
        mockAxiosGet.mockResolvedValueOnce({
            status: 404,
            data: {},
        });

        await expect(fetchAgentImage('token', '@official/builder')).resolves.toBeNull();
    });

    it('throws spec fetch network errors instead of silently returning null', async () => {
        const error = new Error('hub unavailable');
        mockAxiosGet.mockRejectedValueOnce(error);

        await expect(fetchAgentImage('token', '@official/builder:404')).rejects.toThrow('hub unavailable');
        expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch @official/builder:404'));
    });

    it('returns canonical ledger rows for a lineage when available', async () => {
        mockAxiosGet.mockResolvedValueOnce({
            status: 200,
            data: {
                ledger: [
                    {
                        id: 'ledger-1',
                        genomeId: 'genome-1',
                        version: 2,
                        seqNo: 1,
                        timestamp: '2026-03-30T00:00:00.000Z',
                        diffType: 'kv',
                        path: 'behavior.onIdle',
                        op: null,
                        oldValue: '"wait"',
                        newValue: '"self-assign"',
                        content: null,
                    },
                ],
            },
        });

        await expect(fetchAgentPlugLedger('token', '@official', 'implementer')).resolves.toEqual([
            expect.objectContaining({
                id: 'ledger-1',
                diffType: 'kv',
                path: 'behavior.onIdle',
            }),
        ]);
        expect(mockAxiosGet).toHaveBeenCalledWith(
            expect.stringContaining('/genomes/%40official/implementer/ledger'),
            expect.objectContaining({
                headers: { Authorization: 'Bearer token' },
            }),
        );
    });

    it('returns an immutable seed authoring document without coercing it to AgentImage', async () => {
        mockAxiosGet.mockResolvedValueOnce({
            status: 200,
            data: {
                seed: '{"kind":"aha.agent.v1","genome":{"displayName":"Builder"},"package":{"files":{"README.md":"seed"}}}',
            },
        });

        await expect(fetchAgentImageSeed('token', '@official', 'implementer')).resolves.toEqual({
            kind: 'aha.agent.v1',
            genome: { displayName: 'Builder' },
            package: {
                files: {
                    'README.md': 'seed',
                },
            },
        });
    });
});
