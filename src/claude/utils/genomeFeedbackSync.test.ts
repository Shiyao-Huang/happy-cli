import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver';

import type { AggregatedFeedback } from './feedbackPrivacy';
import { normalizeFeedbackProxyBaseUrl, syncGenomeFeedbackToMarketplace } from './genomeFeedbackSync';
import type { FeedbackUploadTarget } from './supervisorAgentVerdict';

const DEFAULT_HUB_URL = DEFAULT_GENOME_HUB_URL.replace(/\/$/, '');
const ORIGINAL_HUB_PUBLISH_KEY = process.env.HUB_PUBLISH_KEY;
const ORIGINAL_GENOME_HUB_AUTH_TOKEN = process.env.GENOME_HUB_AUTH_TOKEN;

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
        source: overrides.source ?? 'explicit-target',
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
    beforeEach(() => {
        delete process.env.HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_AUTH_TOKEN;
    });

    afterEach(() => {
        if (ORIGINAL_HUB_PUBLISH_KEY === undefined) {
            delete process.env.HUB_PUBLISH_KEY;
        } else {
            process.env.HUB_PUBLISH_KEY = ORIGINAL_HUB_PUBLISH_KEY;
        }
        if (ORIGINAL_GENOME_HUB_AUTH_TOKEN === undefined) {
            delete process.env.GENOME_HUB_AUTH_TOKEN;
        } else {
            process.env.GENOME_HUB_AUTH_TOKEN = ORIGINAL_GENOME_HUB_AUTH_TOKEN;
        }
    });

    it('patches feedback by immutable genome id when the target is specimen-bound', async () => {
        const calls: Array<{ input: string; method?: string }> = [];
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({ input, method: init?.method });
            return response(200, '{"genome":{"id":"g-1"}}');
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target: makeTarget({
                genomeId: 'genome-1',
                source: 'score-spec',
            }),
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
                input: `${DEFAULT_HUB_URL}/genomes/id/genome-1/feedback`,
                method: 'PATCH',
            },
        ]);
    });

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
                input: `${DEFAULT_HUB_URL}/genomes/%40official/implementer/feedback`,
                method: 'PATCH',
            },
        ]);
    });

    it('does not auto-create a placeholder when a specimen-bound official target is missing', async () => {
        const calls: Array<{ input: string; method?: string }> = [];
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({ input, method: init?.method });
            return response(404, '{"error":"Genome not found"}');
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target: makeTarget({
                genomeId: 'genome-missing',
                source: 'score-spec',
            }),
            role: 'implementer',
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
                input: `${DEFAULT_HUB_URL}/genomes/id/genome-missing/feedback`,
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
                input: `${DEFAULT_HUB_URL}/genomes/%40official/implementer/feedback`,
                method: 'PATCH',
            },
            {
                input: `${DEFAULT_HUB_URL}/genomes`,
                method: 'POST',
            },
            {
                input: `${DEFAULT_HUB_URL}/genomes/%40official/implementer/feedback`,
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
                input: `${DEFAULT_HUB_URL}/genomes/id/genome-custom-reviewer/feedback`,
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

            if (input.startsWith(DEFAULT_HUB_URL)) {
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
            serverUrl: 'https://aha-agi.com/api',
        });

        expect(result).toMatchObject({
            ok: true,
            status: 200,
            createdGenome: false,
            transport: 'server-proxy',
        });
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({
            input: `${DEFAULT_HUB_URL}/genomes/%40official/implementer/feedback`,
            method: 'PATCH',
        });
        expect(calls[1]).toEqual({
            input: 'https://aha-agi.com/v1/genomes/%40official/implementer/feedback',
            method: 'PATCH',
            auth: 'Bearer user-token',
        });
    });

    it('falls back to the genome-id happy-server proxy path for specimen-bound targets', async () => {
        const calls: Array<{ input: string; method?: string; auth?: string | null }> = [];
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({
                input,
                method: init?.method,
                auth: init?.headers && typeof init.headers === 'object' && 'Authorization' in init.headers
                    ? (init.headers as Record<string, string>).Authorization
                    : null,
            });

            if (input.startsWith(DEFAULT_HUB_URL)) {
                throw new TypeError('fetch failed');
            }

            return response(200, '{"genome":{"id":"g-1","feedbackData":"{}"}}');
        };

        const result = await syncGenomeFeedbackToMarketplace({
            target: makeTarget({
                genomeId: 'genome-1',
                source: 'score-spec',
            }),
            role: 'implementer',
            feedback: makeFeedback(),
            fetchImpl: fetchImpl as any,
            authToken: 'user-token',
            serverUrl: 'https://aha-agi.com/api',
        });

        expect(result).toMatchObject({
            ok: true,
            status: 200,
            createdGenome: false,
            transport: 'server-proxy',
        });
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({
            input: `${DEFAULT_HUB_URL}/genomes/id/genome-1/feedback`,
            method: 'PATCH',
        });
        expect(calls[1]).toEqual({
            input: 'https://aha-agi.com/v1/genomes/id/genome-1/feedback',
            method: 'PATCH',
            auth: 'Bearer user-token',
        });
    });

    it('normalizes API-prefixed server urls to their origin for proxy uploads', () => {
        expect(normalizeFeedbackProxyBaseUrl('https://aha-agi.com/api')).toBe('https://aha-agi.com');
        expect(normalizeFeedbackProxyBaseUrl('https://aha-agi.com/api/')).toBe('https://aha-agi.com');
        expect(normalizeFeedbackProxyBaseUrl('http://localhost:3005')).toBe('http://localhost:3005');
    });
});
