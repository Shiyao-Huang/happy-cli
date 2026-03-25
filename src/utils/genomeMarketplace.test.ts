import { describe, expect, it } from 'vitest';
import {
    buildPublishedCorpsSpec,
    deriveRoleIdFromGenomeRef,
    formatMarketplaceGenomeRef,
    getPreferredGenomeNames,
    parseMarketplaceFeedbackData,
    parseCorpsSpecFromGenome,
    searchMatchesRole,
    selectBestRatedGenomeCandidate,
} from './genomeMarketplace';

describe('genomeMarketplace helpers', () => {
    it('maps role aliases to preferred genome names', () => {
        expect(getPreferredGenomeNames('builder', 'claude')).toEqual(['builder', 'implementer']);
        expect(getPreferredGenomeNames('agent-builder', 'codex')).toEqual(['agent-builder-codex', 'agent-builder']);
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
});
