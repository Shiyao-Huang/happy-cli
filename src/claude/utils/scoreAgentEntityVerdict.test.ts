import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityTrialRecord } from './entityHub';
import {
    buildScoreAgentEntityLogRefs,
    buildScoreAgentVerdictContent,
    recordScoreAgentVerdict,
} from './scoreAgentEntityVerdict';

const mocks = vi.hoisted(() => ({
    createEntityTrialById: vi.fn(),
    createEntityVerdict: vi.fn(),
    listEntityTrialsById: vi.fn(),
    materializeEntityFeedback: vi.fn(),
}));

vi.mock('./entityHub', () => ({
    createEntityTrialById: mocks.createEntityTrialById,
    createEntityVerdict: mocks.createEntityVerdict,
    listEntityTrialsById: mocks.listEntityTrialsById,
    materializeEntityFeedback: mocks.materializeEntityFeedback,
}));

describe('scoreAgentEntityVerdict', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reuses an existing entity trial for the same scored session', async () => {
        const existingTrial: EntityTrialRecord = {
            id: 'trial-1',
            entityId: 'entity-1',
            entityVersion: 2,
            teamId: 'team-1',
            contextNarrative: null,
            logRefs: [{ kind: 'other', path: 'aha://session/session-1', sessionId: 'session-1' }],
            startedAt: '2026-03-31T00:00:00.000Z',
            endedAt: null,
        };

        mocks.listEntityTrialsById.mockResolvedValue([existingTrial]);
        mocks.createEntityVerdict.mockResolvedValue({ verdict: { id: 'verdict-1' } });
        mocks.materializeEntityFeedback.mockResolvedValue({ avgScore: 90, evaluationCount: 1 });

        const result = await recordScoreAgentVerdict({
            token: 'hub-key',
            entityId: 'entity-1',
            sessionId: 'session-1',
            teamId: 'team-1',
            scoredRole: 'implementer',
            readerRole: 'supervisor',
            readerSessionId: 'reader-1',
            overall: 90,
            action: 'keep',
            dimensions: {
                delivery: 91,
                integrity: 92,
                efficiency: 88,
                collaboration: 89,
                reliability: 90,
            },
            recommendations: ['none'],
        });

        expect(mocks.createEntityTrialById).not.toHaveBeenCalled();
        expect(mocks.createEntityVerdict).toHaveBeenCalledWith(expect.objectContaining({
            token: 'hub-key',
            trialId: 'trial-1',
            readerRole: 'supervisor',
            score: 90,
        }));
        expect(mocks.materializeEntityFeedback).toHaveBeenCalledWith({
            token: 'hub-key',
            entityId: 'entity-1',
        });
        expect(result).toEqual({ trialId: 'trial-1', verdictId: 'verdict-1' });
    });

    it('creates a new entity trial with session-derived log refs when none exists', async () => {
        mocks.listEntityTrialsById.mockResolvedValue([]);
        mocks.createEntityTrialById.mockResolvedValue({
            trial: {
                id: 'trial-2',
                entityId: 'entity-2',
                entityVersion: 3,
                teamId: 'team-2',
                contextNarrative: null,
                logRefs: [],
                startedAt: '2026-03-31T00:00:00.000Z',
                endedAt: null,
            },
        });
        mocks.createEntityVerdict.mockResolvedValue({ verdict: { id: 'verdict-2' } });
        mocks.materializeEntityFeedback.mockResolvedValue({ avgScore: 82, evaluationCount: 1 });

        const result = await recordScoreAgentVerdict({
            token: 'hub-key',
            entityId: 'entity-2',
            sessionId: 'session-2',
            teamId: 'team-2',
            scoredRole: 'supervisor',
            readerRole: 'org-manager',
            readerSessionId: 'reader-2',
            overall: 82,
            action: 'mutate',
            dimensions: {
                delivery: 80,
                integrity: 83,
                efficiency: 81,
                collaboration: 82,
                reliability: 84,
            },
            recommendations: ['tighten protocol'],
            mapping: {
                sessionId: 'session-2',
                runtimeType: 'codex',
                claudeSessionId: 'claude-123',
                codexRolloutId: 'codex-456',
                specId: 'entity-2',
                specRef: '@official/supervisor:3',
                specVersion: 3,
                teamId: 'team-2',
                startedAt: Date.now(),
            },
        });

        expect(mocks.createEntityTrialById).toHaveBeenCalledWith(expect.objectContaining({
            token: 'hub-key',
            entityId: 'entity-2',
            teamId: 'team-2',
            logRefs: expect.arrayContaining([
                expect.objectContaining({ kind: 'other', sessionId: 'session-2' }),
                expect.objectContaining({ kind: 'team', path: 'aha://team/team-2' }),
                expect.objectContaining({ kind: 'claude', sessionId: 'claude-123' }),
                expect.objectContaining({ kind: 'codex', sessionId: 'codex-456' }),
            ]),
        }));
        expect(result).toEqual({ trialId: 'trial-2', verdictId: 'verdict-2' });
    });

    it('formats log refs and verdict content deterministically', () => {
        expect(buildScoreAgentEntityLogRefs({
            sessionId: 'session-3',
            teamId: 'team-3',
            mapping: null,
        })).toEqual([
            { kind: 'other', path: 'aha://session/session-3', sessionId: 'session-3' },
            { kind: 'team', path: 'aha://team/team-3' },
        ]);

        expect(buildScoreAgentVerdictContent({
            scoredRole: 'supervisor',
            sessionId: 'session-3',
            overall: 77,
            action: 'keep_with_guardrails',
            dimensions: {
                delivery: 75,
                integrity: 78,
                efficiency: 76,
                collaboration: 80,
                reliability: 77,
            },
            recommendations: ['verify logs'],
        })).toContain('Overall: 77/100, Action: keep_with_guardrails');
    });
});
