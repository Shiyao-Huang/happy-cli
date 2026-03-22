import { describe, expect, it } from 'vitest';
import {
    buildPublishedCorpsSpec,
    getPreferredGenomeNames,
    parseMarketplaceFeedbackData,
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
});
