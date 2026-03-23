import { describe, expect, it } from 'vitest';

import type { AggregatedFeedback } from './feedbackPrivacy';
import { normalizeFeedbackProxyBaseUrl, syncGenomeFeedbackToMarketplace } from './genomeFeedbackSync';
import type { FeedbackUploadTarget } from './supervisorGenomeFeedback';

function makeFeedback(): AggregatedFeedback {
    return {
        evaluationCount: 3,
        avgScore: 88,
        sessionScore: {
            taskCompletion: 87,
            codeQuality: 88,
            collaboration: 89,
            overall: 88,
        },
        dimensions: {
            delivery: 88,
            integrity: 87,
            efficiency: 86,
            collaboration: 89,
            reliability: 88,
        },
        distribution: {
            excellent: 2,
            good: 1,
            fair: 0,
            poor: 0,
        },
        latestAction: 'keep',
        suggestions: ['Keeps team updates concise and grounded in evidence.'],
    };
}

function makeTarget(overrides: Partial<FeedbackUploadTarget> = {}): FeedbackUploadTarget {
    return {
        namespace: overrides.namespace ?? '@official',
        name: overrides.name ?? 'implementer',
        source: overrides.source ?? 'role-fallback',
        ...(overrides.genomeId ? { genomeId: overrides.genomeId } : {}),
    };
}

function response(status: number, body: string) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return body;
        },
    };
}

describe('syncGenomeFeedbackToMarketplace', () => {
    it('patches feedback directly when the target genome already exists', async () => {
        const calls: Array<{ input: string; method?: string }> = [];
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({ input, method: init?.method });
            return response(200, '{"genome":{"id":"g-1"}}');
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target: makeTarget(),
            role: 'implementer',
            feedback: makeFeedback(),
            fetchImpl: fetchImpl as any,
        });

        expect(result).toMatchObject({
            ok: true,
            status: 200,
            createdGenome: false,
            transport: 'direct-hub',
        });
        expect(calls).toEqual([
            {
                input: 'http://localhost:3006/genomes/%40official/implementer/feedback',
                method: 'PATCH',
            },
        ]);
    });

    it('creates a canonical official genome placeholder and retries feedback upload after a 404', async () => {
        const calls: Array<{ input: string; method?: string }> = [];
        const responses = [
            response(404, '{"error":"Genome not found"}'),
            response(201, '{"genome":{"id":"g-implementer"}}'),
            response(200, '{"genome":{"id":"g-implementer","feedbackData":"{}"}}'),
        ];
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({ input, method: init?.method });
            return responses.shift()!;
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target: makeTarget(),
            role: 'Implementer',
            feedback: makeFeedback(),
            fetchImpl: fetchImpl as any,
        });

        expect(result).toMatchObject({
            ok: true,
            status: 200,
            createdGenome: true,
            transport: 'direct-hub',
        });
        expect(calls).toEqual([
            {
                input: 'http://localhost:3006/genomes/%40official/implementer/feedback',
                method: 'PATCH',
            },
            {
                input: 'http://localhost:3006/genomes',
                method: 'POST',
            },
            {
                input: 'http://localhost:3006/genomes/%40official/implementer/feedback',
                method: 'PATCH',
            },
        ]);
    });

    it('does not auto-create non-canonical targets after a 404', async () => {
        const calls: Array<{ input: string; method?: string }> = [];
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({ input, method: init?.method });
            return response(404, '{"error":"Genome not found"}');
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target: makeTarget({
                namespace: '@public',
                name: 'custom-reviewer',
                source: 'score-spec',
                genomeId: 'genome-custom-reviewer',
            }),
            role: 'custom-reviewer',
            feedback: makeFeedback(),
            fetchImpl: fetchImpl as any,
        });

        expect(result).toMatchObject({
            ok: false,
            status: 404,
            createdGenome: false,
            transport: 'direct-hub',
        });
        expect(calls).toEqual([
            {
                input: 'http://localhost:3006/genomes/%40public/custom-reviewer/feedback',
                method: 'PATCH',
            },
        ]);
    });

    it('falls back to happy-server proxy when direct genome-hub access fails', async () => {
        const calls: Array<{ input: string; method?: string; auth?: string | null }> = [];
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({
                input,
                method: init?.method,
                auth: init?.headers && typeof init.headers === 'object' && 'Authorization' in init.headers
                    ? (init.headers as Record<string, string>).Authorization
                    : null,
            });

            if (input.startsWith('http://localhost:3006/')) {
                throw new TypeError('fetch failed');
            }

            return response(200, '{"genome":{"id":"g-1","feedbackData":"{}"}}');
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target: makeTarget(),
            role: 'implementer',
            feedback: makeFeedback(),
            fetchImpl: fetchImpl as any,
            authToken: 'user-token',
            serverUrl: 'https://top1vibe.com/api/v3',
        });

        expect(result).toMatchObject({
            ok: true,
            status: 200,
            createdGenome: false,
            transport: 'server-proxy',
        });
        expect(calls).toEqual([
            {
                input: 'http://localhost:3006/genomes/%40official/implementer/feedback',
                method: 'PATCH',
                auth: null,
            },
            {
                input: 'https://top1vibe.com/v1/genomes/%40official/implementer/feedback',
                method: 'PATCH',
                auth: 'Bearer user-token',
            },
        ]);
    });

    it('normalizes API-prefixed server urls to their origin for proxy uploads', () => {
        expect(normalizeFeedbackProxyBaseUrl('https://top1vibe.com/api/v3')).toBe('https://top1vibe.com');
        expect(normalizeFeedbackProxyBaseUrl('https://top1vibe.com/api/v3/')).toBe('https://top1vibe.com');
        expect(normalizeFeedbackProxyBaseUrl('http://localhost:3005')).toBe('http://localhost:3005');
    });
});
