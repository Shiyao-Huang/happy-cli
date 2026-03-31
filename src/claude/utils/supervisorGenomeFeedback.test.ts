import { describe, expect, it } from 'vitest';

import type { AgentScore } from './scoreStorage';
import {
    getCanonicalGenomeTargetForRole,
    resolveFeedbackUploadTarget,
    scoreMatchesFeedbackTarget,
    deriveFeedbackTargetFromScores,
} from './supervisorAgentVerdict';

function makeScore(overrides: Partial<AgentScore>): AgentScore {
    return {
        sessionId: overrides.sessionId ?? 'session-1',
        teamId: overrides.teamId ?? 'team-1',
        role: overrides.role ?? 'master',
        timestamp: overrides.timestamp ?? 1,
        scorer: overrides.scorer ?? 'supervisor-1',
        dimensions: overrides.dimensions ?? {
            delivery: 80,
            integrity: 80,
            efficiency: 80,
            collaboration: 80,
            reliability: 80,
        },
        overall: overrides.overall ?? 80,
        evidence: overrides.evidence ?? {},
        recommendations: overrides.recommendations ?? [],
        action: overrides.action ?? 'keep',
        ...(overrides.specId ? { specId: overrides.specId } : {}),
        ...(overrides.specNamespace ? { specNamespace: overrides.specNamespace } : {}),
        ...(overrides.specName ? { specName: overrides.specName } : {}),
    };
}

describe('supervisorAgentVerdict', () => {
    it('maps legacy supervisor role aliases onto canonical official genomes', () => {
        expect(getCanonicalGenomeTargetForRole('solution-architect')).toEqual({
            namespace: '@official',
            name: 'architect',
        });
        expect(getCanonicalGenomeTargetForRole('builder')).toEqual({
            namespace: '@official',
            name: 'implementer',
        });
        expect(getCanonicalGenomeTargetForRole('scout')).toEqual({
            namespace: '@official',
            name: 'researcher',
        });
        expect(getCanonicalGenomeTargetForRole('reviewer')).toEqual({
            namespace: '@official',
            name: 'qa-engineer',
        });
        expect(getCanonicalGenomeTargetForRole('qa')).toEqual({
            namespace: '@official',
            name: 'qa-engineer',
        });
    });

    it('maps bypass roles (supervisor, help-agent) to their canonical genomes', () => {
        expect(getCanonicalGenomeTargetForRole('supervisor')).toEqual({
            namespace: '@official',
            name: 'supervisor',
        });
        expect(getCanonicalGenomeTargetForRole('help-agent')).toEqual({
            namespace: '@official',
            name: 'help-agent',
        });
    });

    it('returns null when only role is provided and fallback is disabled', () => {
        expect(resolveFeedbackUploadTarget({
            role: 'supervisor',
        })).toBeNull();
    });

    it('prefers exact scored genome identity when available', () => {
        expect(resolveFeedbackUploadTarget({
            role: 'master',
            specId: 'genome-1',
            specNamespace: '@official',
            specName: 'master',
        })).toEqual({
            genomeId: 'genome-1',
            namespace: '@official',
            name: 'master',
            source: 'score-spec',
        });
    });

    it('accepts explicit namespace/name when the caller intentionally specifies a target', () => {
        expect(resolveFeedbackUploadTarget({
            role: 'org-manager',
            specNamespace: '@official',
            specName: 'org-manager',
        })).toEqual({
            namespace: '@official',
            name: 'org-manager',
            source: 'explicit-target',
        });
    });

    it('returns null when spec id exists but namespace/name are unresolved', () => {
        expect(resolveFeedbackUploadTarget({
            role: 'QA Engineer',
            specId: 'genome-qa-1',
        })).toBeNull();
    });

    it('matches only explicit namespace/name scores when the target has no genome id', () => {
        const target = resolveFeedbackUploadTarget({
            role: 'solution-architect',
            specNamespace: '@official',
            specName: 'architect',
        });
        expect(target).not.toBeNull();
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'architect', specNamespace: '@official', specName: 'architect' }),
            target!,
        )).toBe(true);
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'solution-architect' }),
            target!,
        )).toBe(false);
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'master' }),
            target!,
        )).toBe(false);
    });

    it('matches only the exact genome id when target is specimen-bound', () => {
        const target = resolveFeedbackUploadTarget({
            role: 'org-manager',
            specId: 'genome-org-manager',
            specNamespace: '@official',
            specName: 'org-manager',
        });
        expect(target).not.toBeNull();
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'org-manager', specId: 'genome-org-manager' }),
            target!,
        )).toBe(true);
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'org-manager', specNamespace: '@official', specName: 'org-manager' }),
            target!,
        )).toBe(false);
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'master' }),
            target!,
        )).toBe(false);
    });
});

describe('deriveFeedbackTargetFromScores', () => {
    it('preserves existing genomeId without inspecting scores', () => {
        const target = {
            genomeId: 'entity-v3',
            namespace: '@official',
            name: 'master',
            source: 'score-spec' as const,
        };
        const result = deriveFeedbackTargetFromScores(target, [
            makeScore({ specId: 'entity-v2' }),
        ]);
        expect(result.genomeId).toBe('entity-v3');
    });

    it('derives genomeId when all scores share the same specId', () => {
        const target = {
            namespace: '@official',
            name: 'master',
            source: 'explicit-target' as const,
        };
        const scores = [
            makeScore({ specId: 'entity-v3', specNamespace: '@official', specName: 'master' }),
            makeScore({ specId: 'entity-v3', specNamespace: '@official', specName: 'master' }),
        ];
        const result = deriveFeedbackTargetFromScores(target, scores);
        expect(result.genomeId).toBe('entity-v3');
        expect(result.namespace).toBe('@official');
        expect(result.name).toBe('master');
    });

    it('does not derive genomeId when scores have mixed specIds', () => {
        const target = {
            namespace: '@official',
            name: 'master',
            source: 'explicit-target' as const,
        };
        const scores = [
            makeScore({ specId: 'entity-v2', specNamespace: '@official', specName: 'master' }),
            makeScore({ specId: 'entity-v3', specNamespace: '@official', specName: 'master' }),
        ];
        const result = deriveFeedbackTargetFromScores(target, scores);
        expect(result.genomeId).toBeUndefined();
    });

    it('does not derive genomeId when scores have no specId', () => {
        const target = {
            namespace: '@official',
            name: 'master',
            source: 'explicit-target' as const,
        };
        const scores = [
            makeScore({ specNamespace: '@official', specName: 'master' }),
        ];
        const result = deriveFeedbackTargetFromScores(target, scores);
        expect(result.genomeId).toBeUndefined();
    });

    it('does not derive genomeId when scores array is empty', () => {
        const target = {
            namespace: '@official',
            name: 'master',
            source: 'explicit-target' as const,
        };
        const result = deriveFeedbackTargetFromScores(target, []);
        expect(result.genomeId).toBeUndefined();
    });
});
