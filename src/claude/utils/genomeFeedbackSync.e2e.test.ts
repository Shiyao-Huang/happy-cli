import { describe, expect, it } from 'vitest';
import { normalizeFeedbackProxyBaseUrl, syncGenomeFeedbackToMarketplace } from './genomeFeedbackSync';
import type { FeedbackUploadTarget } from './supervisorAgentVerdict';
import type { AggregatedFeedback } from './feedbackPrivacy';

const GENOME_HUB_URL = process.env.GENOME_HUB_URL || 'http://localhost:3006';

const isHubReachable = await (async () => {
    try {
        const r = await fetch(`${GENOME_HUB_URL}/genomes?limit=1`);
        return r.ok;
    } catch { return false; }
})();

function makeFeedback(overrides: Partial<AggregatedFeedback> = {}): AggregatedFeedback {
    return {
        evaluationCount: 1,
        avgScore: 72,
        sessionScore: { taskCompletion: 70, codeQuality: 75, collaboration: 72, overall: 72 },
        dimensions: { delivery: 70, integrity: 72, efficiency: 71, collaboration: 73, reliability: 74 },
        distribution: { excellent: 0, good: 1, fair: 0, poor: 0 },
        latestAction: 'keep',
        suggestions: ['Docker L3 E2E test feedback'],
        ...overrides,
    };
}

describe.skipIf(!isHubReachable)('genomeFeedbackSync E2E (real genome-hub)', () => {
    it('patches feedback to @official/implementer via name route', async () => {
        const target: FeedbackUploadTarget = {
            namespace: '@official',
            name: 'implementer',
            source: 'explicit-target',
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target,
            role: 'implementer',
            feedback: makeFeedback(),
            hubUrl: GENOME_HUB_URL,
        });

        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        expect(result.transport).toBe('direct-hub');
    });

    it('patches feedback to @official/implementer via version route (F-023)', async () => {
        const latestRes = await fetch(`${GENOME_HUB_URL}/genomes/%40official/implementer/latest`);
        const { genome } = await latestRes.json() as any;
        const version = genome.version as number;

        const target: FeedbackUploadTarget = {
            namespace: '@official',
            name: 'implementer',
            version,
            source: 'explicit-target',
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target,
            role: 'implementer',
            feedback: makeFeedback({ avgScore: 73 }),
            hubUrl: GENOME_HUB_URL,
        });

        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        expect(result.transport).toBe('direct-hub');
    });

    it('patches feedback to @official/implementer via genomeId route', async () => {
        const latestRes = await fetch(`${GENOME_HUB_URL}/genomes/%40official/implementer/latest`);
        const { genome } = await latestRes.json() as any;

        const target: FeedbackUploadTarget = {
            namespace: '@official',
            name: 'implementer',
            genomeId: genome.id,
            source: 'score-spec',
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target,
            role: 'implementer',
            feedback: makeFeedback({ avgScore: 74 }),
            hubUrl: GENOME_HUB_URL,
        });

        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        expect(result.transport).toBe('direct-hub');
    });

    it('returns 404 for non-existent genome', async () => {
        const target: FeedbackUploadTarget = {
            namespace: '@ghost',
            name: 'does-not-exist',
            source: 'explicit-target',
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target,
            role: 'ghost',
            feedback: makeFeedback(),
            hubUrl: GENOME_HUB_URL,
        });

        expect(result.ok).toBe(false);
        expect(result.status).toBe(404);
    });

    it('supervisor genome has ≤45 tools (F-020 bypass fix validation)', async () => {
        const res = await fetch(`${GENOME_HUB_URL}/genomes/%40official/supervisor/latest`);
        const { genome } = await res.json() as any;
        const spec = typeof genome.spec === 'string' ? JSON.parse(genome.spec) : genome.spec;
        const tools = spec.allowedTools || [];

        expect(tools.length).toBeLessThanOrEqual(45);
        expect(tools.length).toBeGreaterThan(0);
    });

    it('all @official agent genomes have valid structure', async () => {
        const res = await fetch(`${GENOME_HUB_URL}/genomes?namespace=%40official&limit=50`);
        const { genomes } = await res.json() as any;

        for (const g of genomes) {
            if (g.kind === 'legion') continue;
            const spec = typeof g.spec === 'string' ? JSON.parse(g.spec) : g.spec;
            expect(spec, `${g.namespace}/${g.name} missing spec`).toBeTruthy();
            expect(spec.displayName || spec.baseRoleId, `${g.namespace}/${g.name} missing identity`).toBeTruthy();
        }
    });
});
