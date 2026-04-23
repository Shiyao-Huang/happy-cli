import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildPublishedCorpsSpec,
    deriveRoleIdFromGenomeRef,
    fetchMarketplaceGenomeDetail,
    formatMarketplaceGenomeRef,
    getPreferredGenomeNames,
    parseMarketplaceFeedbackData,
    parseCorpsSpecFromGenome,
    resolveOfficialGenomeSpecId,
    resolveSpawnRuntimeForRole,
    searchMarketplaceGenomes,
    searchMatchesRole,
    selectBestRatedGenomeCandidate,
} from './genomeMarketplace';

describe('genomeMarketplace helpers', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('maps role aliases to preferred genome names', () => {
        expect(getPreferredGenomeNames('builder', 'claude')).toEqual(['builder', 'implementer']);
        expect(getPreferredGenomeNames('agent-builder', 'codex')).toEqual([
            'agent-builder-codex-r2',
            'agent-builder-codex',
            'agent-builder',
        ]);
        expect(getPreferredGenomeNames('agent-builder', 'claude')).toEqual([
            'agent-builder-r2',
            'agent-builder',
            'agent-builder-portable',
        ]);
    });

    it('defaults agent-builder spawns to codex when chat create flow does not specify a runtime', () => {
        expect(resolveSpawnRuntimeForRole('agent-builder')).toBe('codex');
        expect(resolveSpawnRuntimeForRole('builder')).toBe('claude');
        expect(resolveSpawnRuntimeForRole('agent-builder', 'claude')).toBe('claude');
        expect(resolveSpawnRuntimeForRole('builder', 'codex')).toBe('codex');
    });

    it('parses feedback summaries safely', () => {
        expect(parseMarketplaceFeedbackData('{"avgScore":88,"evaluationCount":4}')).toEqual({ avgScore: 88, evaluationCount: 4 });
        expect(parseMarketplaceFeedbackData('not-json')).toEqual({ avgScore: 0, evaluationCount: 0 });
    });

    it('prefers exact high-rated matches when selecting best-rated genomes', () => {
        const selected = selectBestRatedGenomeCandidate([
            {
                id: '1',
                namespace: '@community',
                name: 'implementer',
                feedbackData: '{"avgScore":78,"evaluationCount":5}',
                spawnCount: 3,
            },
            {
                id: '2',
                namespace: '@community',
                name: 'builder',
                feedbackData: '{"avgScore":81,"evaluationCount":4}',
                spawnCount: 1,
            },
        ], ['builder', 'implementer']);

        expect(selected?.id).toBe('2');
    });

    it('prefers the higher-rated builder variant over the exact lower-rated name', () => {
        const selected = selectBestRatedGenomeCandidate([
            {
                id: 'legacy',
                namespace: '@official',
                name: 'agent-builder-codex',
                tags: '["agent-builder","codex"]',
                feedbackData: '{"avgScore":74,"evaluationCount":4}',
                spawnCount: 20,
            },
            {
                id: 'r2',
                namespace: '@public',
                name: 'agent-builder-codex-r2',
                tags: '["agent-builder","codex"]',
                feedbackData: '{"avgScore":85,"evaluationCount":6}',
                spawnCount: 4,
            },
        ], ['agent-builder-codex', 'agent-builder']);

        expect(selected?.id).toBe('r2');
    });

    it('ignores stale higher-rated versions from the same lineage and keeps the latest version only', () => {
        const selected = selectBestRatedGenomeCandidate([
            {
                id: 'master-v2',
                namespace: '@official',
                name: 'master',
                version: 2,
                feedbackData: '{"avgScore":91,"evaluationCount":12}',
                spawnCount: 20,
            },
            {
                id: 'master-v3',
                namespace: '@official',
                name: 'master',
                version: 3,
                feedbackData: '{"avgScore":0,"evaluationCount":0}',
                spawnCount: 0,
            },
        ], ['master']);

        expect(selected).toBeNull();
    });

    it('filters best-rated candidates by requested runtime so codex requests do not reuse claude genomes', () => {
        const selected = selectBestRatedGenomeCandidate([
            {
                id: 'impl-claude',
                namespace: '@official',
                name: 'implementer',
                runtimeType: 'claude',
                feedbackData: '{"avgScore":96,"evaluationCount":12}',
                spawnCount: 40,
            },
            {
                id: 'builder-codex',
                namespace: '@official',
                name: 'agent-builder-codex',
                runtimeType: 'codex',
                tags: '["agent-builder","codex"]',
                feedbackData: '{"avgScore":84,"evaluationCount":5}',
                spawnCount: 5,
            },
        ], ['implementer', 'agent-builder-codex', 'agent-builder'], {
            runtimeType: 'codex',
        });

        expect(selected?.id).toBe('builder-codex');
    });

    it('treats legacy genomes without runtimeType as compatible fallback candidates', () => {
        const selected = selectBestRatedGenomeCandidate([
            {
                id: 'legacy-builder',
                namespace: '@official',
                name: 'agent-builder-codex',
                tags: '["agent-builder","codex"]',
                feedbackData: '{"avgScore":82,"evaluationCount":4}',
                spawnCount: 8,
            },
        ], ['agent-builder-codex', 'agent-builder'], {
            runtimeType: 'codex',
        });

        expect(selected?.id).toBe('legacy-builder');
    });

    it('builds corps specs by aggregating duplicate members into counts', () => {
        const corps = buildPublishedCorpsSpec({
            name: 'delivery-squad',
            description: 'Auto-published corps template',
            teamDescription: 'Delivery Squad',
            initialObjective: 'Ship the sprint backlog',
            members: [
                { genome: '@official/master', roleAlias: 'master', required: true },
                { genome: '@official/implementer', roleAlias: 'builder', required: true },
                { genome: '@official/implementer', roleAlias: 'builder', required: true },
            ],
        });

        expect(corps.members).toHaveLength(2);
        expect(corps.members.find((member) => member.roleAlias === 'builder')?.count).toBe(2);
        expect(corps.bootContext?.initialObjective).toBe('Ship the sprint backlog');
    });

    it('does not merge members that have different overlays', () => {
        const corps = buildPublishedCorpsSpec({
            name: 'delivery-squad',
            description: 'Auto-published corps template',
            members: [
                {
                    genome: '@official/implementer:3',
                    roleAlias: 'builder',
                    required: true,
                    overlay: { promptSuffix: 'Focus on backend tasks.' },
                },
                {
                    genome: '@official/implementer:3',
                    roleAlias: 'builder',
                    required: true,
                    overlay: { promptSuffix: 'Focus on frontend tasks.' },
                },
            ],
        });

        expect(corps.members).toHaveLength(2);
        expect(corps.members.every((member) => member.count === 1)).toBe(true);
    });

    it('strips internal bootContext fields from public corps specs', () => {
        // Private publish: internal fields included
        const privateCorps = buildPublishedCorpsSpec({
            name: 'squad',
            description: 'Private corps',
            initialObjective: 'Sensitive team objective',
            sharedContext: ['internal-repo-url'],
            commandChain: ['ceo', 'cto'],
            taskPolicy: { requireApproval: true },
            members: [{ genome: '@official/master', roleAlias: 'master', required: true }],
        });
        expect(privateCorps.bootContext?.initialObjective).toBe('Sensitive team objective');
        expect(privateCorps.bootContext?.sharedContext).toEqual(['internal-repo-url']);

        // Public publish: internal fields must be absent (stripped by caller)
        const publicCorps = buildPublishedCorpsSpec({
            name: 'squad',
            description: 'Public corps',
            // caller omits internal fields for public publish
            members: [{ genome: '@official/master', roleAlias: 'master', required: true }],
        });
        expect(publicCorps.bootContext?.initialObjective).toBeUndefined();
        expect(publicCorps.bootContext?.sharedContext).toBeUndefined();
        expect(publicCorps.bootContext?.commandChain).toBeUndefined();
        expect(publicCorps.bootContext?.taskPolicy).toBeUndefined();
    });

    it('formats pinned genome refs for corps publishing and template spawn', () => {
        expect(formatMarketplaceGenomeRef({
            namespace: '@public',
            name: 'fullstack-squad',
            version: 4,
        }, { pinVersion: true })).toBe('@public/fullstack-squad:4');
        expect(deriveRoleIdFromGenomeRef('@official/qa-engineer:2')).toBe('qa-engineer');
    });

    it('parses corps specs from marketplace records', () => {
        const corps = parseCorpsSpecFromGenome({
            name: 'fullstack-squad',
            category: 'corps',
            spec: JSON.stringify({
                namespace: '@public',
                name: 'fullstack-squad',
                version: 1,
                description: 'Template',
                members: [
                    { genome: '@official/master', roleAlias: 'master' },
                ],
            }),
        });

        expect(corps.members[0]?.roleAlias).toBe('master');
    });

    it('falls back to tokenized marketplace search when an exact multi-word query returns no matches', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockImplementation(async (...args) => {
            const input = args[0] as string | URL | Request;
            const url = String(input);
            if (url.includes('q=implementer+builder')) {
                return new Response(JSON.stringify({ genomes: [] }), { status: 200 });
            }
            if (url.includes('q=implementer')) {
                return new Response(JSON.stringify({
                    genomes: [
                        { id: 'impl-1', namespace: '@official', name: 'implementer', feedbackData: '{"avgScore":90,"evaluationCount":5}' },
                    ],
                }), { status: 200 });
            }
            if (url.includes('q=builder')) {
                return new Response(JSON.stringify({
                    genomes: [
                        { id: 'builder-1', namespace: '@official', name: 'gstack-fullstack-builder', feedbackData: '{"avgScore":88,"evaluationCount":4}' },
                    ],
                }), { status: 200 });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
        });

        const genomes = await searchMarketplaceGenomes({
            query: 'implementer builder',
            limit: 5,
            hubUrl: 'http://example.test',
        });

        expect(genomes.map((genome) => genome.id)).toEqual(['impl-1', 'builder-1']);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('deduplicates fallback token results and respects the requested limit', async () => {
        vi.spyOn(globalThis, 'fetch' as never).mockImplementation(async (...args) => {
            const input = args[0] as string | URL | Request;
            const url = String(input);
            if (url.includes('q=implementer+builder')) {
                return new Response(JSON.stringify({ genomes: [] }), { status: 200 });
            }
            if (url.includes('q=implementer')) {
                return new Response(JSON.stringify({
                    genomes: [
                        { id: 'shared', namespace: '@official', name: 'implementer' },
                        { id: 'impl-2', namespace: '@official', name: 'implementer-r2' },
                    ],
                }), { status: 200 });
            }
            if (url.includes('q=builder')) {
                return new Response(JSON.stringify({
                    genomes: [
                        { id: 'shared', namespace: '@official', name: 'implementer' },
                        { id: 'builder-2', namespace: '@official', name: 'agent-builder' },
                    ],
                }), { status: 200 });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
        });

        const genomes = await searchMarketplaceGenomes({
            query: 'implementer builder',
            limit: 2,
            hubUrl: 'http://example.test',
        });

        expect(genomes.map((genome) => genome.id)).toEqual(['shared', 'impl-2']);
    });

    it('passes runtimeType through marketplace search requests', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
            new Response(JSON.stringify({ genomes: [] }), { status: 200 }),
        );

        await searchMarketplaceGenomes({
            query: 'agent-builder',
            runtimeType: 'codex',
            limit: 5,
            hubUrl: 'http://example.test',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://example.test/genomes?q=agent-builder&runtimeType=codex&sortBy=score&limit=5',
            expect.any(Object),
        );
    });

    it('accepts official legacy genomes when runtimeType has not been backfilled yet', async () => {
        vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
            new Response(JSON.stringify({
                genome: {
                    id: 'legacy-official-builder',
                    runtimeType: null,
                },
            }), { status: 200 }),
        );

        await expect(resolveOfficialGenomeSpecId('agent-builder', 'codex', 'http://example.test')).resolves.toEqual({
            specId: '@official/agent-builder-codex-r2',
            entityId: 'legacy-official-builder',
            hubUrl: 'http://example.test',
            matchedName: 'agent-builder-codex-r2',
        });
    });

    it('returns a semantic official ref instead of leaking hub-local UUIDs', async () => {
        vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
            new Response(JSON.stringify({
                genome: {
                    id: 'cm-hub-local-org-manager',
                    namespace: '@official',
                    name: 'org-manager',
                    runtimeType: 'claude',
                    version: 3,
                },
            }), { status: 200 }),
        );

        await expect(resolveOfficialGenomeSpecId('org-manager', 'claude', 'https://hub.example/genome')).resolves.toMatchObject({
            specId: '@official/org-manager',
            entityId: 'cm-hub-local-org-manager',
            hubUrl: 'https://hub.example/genome',
            matchedName: 'org-manager',
        });
    });

    it('deduplicates repeated marketplace detail reads by url', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
            new Response(JSON.stringify({
                genome: {
                    id: 'detail-1',
                    namespace: '@official',
                    name: 'help-agent',
                },
            }), { status: 200 }),
        );

        const first = await fetchMarketplaceGenomeDetail('detail-1', 'http://detail-cache.test');
        const second = await fetchMarketplaceGenomeDetail('detail-1', 'http://detail-cache.test');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(first?.name).toBe('help-agent');
        expect(second?.name).toBe('help-agent');
    });

    it('URL-encodes semantic refs when reading marketplace details', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
            new Response(JSON.stringify({
                genome: {
                    id: 'detail-special',
                    namespace: '@official',
                    name: 'org manager#north?lane',
                },
            }), { status: 200 }),
        );

        await fetchMarketplaceGenomeDetail('@official/org manager#north?lane', 'http://detail-encoding.test');

        expect(fetchMock).toHaveBeenCalledWith(
            'http://detail-encoding.test/genomes/%40official/org%20manager%23north%3Flane',
            expect.any(Object),
        );
    });

    it('stops token fallback searches after the marketplace returns a 429', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
            new Response(JSON.stringify({ genomes: [] }), { status: 429 }),
        );

        const genomes = await searchMarketplaceGenomes({
            query: 'help agent',
            limit: 5,
            hubUrl: 'http://cooldown.test',
        });

        expect(genomes).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
