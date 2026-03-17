import { describe, expect, it } from 'vitest';
import { aggregateScores } from './feedbackPrivacy';
import type { AgentScore } from './scoreStorage';

function makeScore(partial: Partial<AgentScore>): AgentScore {
    return {
        sessionId: partial.sessionId ?? 'session-1',
        teamId: partial.teamId ?? 'team-1',
        role: partial.role ?? 'implementer',
        timestamp: partial.timestamp ?? Date.now(),
        scorer: partial.scorer ?? 'supervisor-1',
        dimensions: partial.dimensions ?? {
            delivery: 80,
            integrity: 82,
            efficiency: 78,
            collaboration: 84,
            reliability: 86,
        },
        overall: partial.overall ?? 84,
        evidence: partial.evidence ?? {},
        recommendations: partial.recommendations ?? [],
        action: partial.action ?? 'keep',
        hardMetrics: partial.hardMetrics,
        businessMetrics: partial.businessMetrics,
        hardMetricsScore: partial.hardMetricsScore,
        sessionScore: partial.sessionScore,
        scoreGap: partial.scoreGap,
        specId: partial.specId,
        specNamespace: partial.specNamespace,
        specName: partial.specName,
    };
}

describe('aggregateScores', () => {
    it('aggregates sessionScore alongside dimensions', () => {
        const aggregated = aggregateScores([
            makeScore({
                sessionId: 's1',
                overall: 84,
                sessionScore: {
                    taskCompletion: 90,
                    codeQuality: 80,
                    collaboration: 82,
                    overall: 84,
                },
            }),
            makeScore({
                sessionId: 's2',
                overall: 78,
                sessionScore: {
                    taskCompletion: 76,
                    codeQuality: 79,
                    collaboration: 80,
                    overall: 78,
                },
                action: 'keep_with_guardrails',
                timestamp: Date.now() + 1,
            }),
        ]);

        expect(aggregated).not.toBeNull();
        expect(aggregated?.avgScore).toBe(81);
        expect(aggregated?.sessionScore).toEqual({
            taskCompletion: 83,
            codeQuality: 80,
            collaboration: 81,
            overall: 81,
        });
        expect(aggregated?.latestAction).toBe('keep_with_guardrails');
    });
});
