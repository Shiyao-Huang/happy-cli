import { describe, expect, it } from 'vitest';

import type { AgentScore } from './scoreStorage';
import {
    getCanonicalGenomeTargetForRole,
    resolveFeedbackUploadTarget,
    scoreMatchesFeedbackTarget,
} from './supervisorGenomeFeedback';

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

describe('supervisorGenomeFeedback', () => {
    it('maps legacy supervisor role aliases onto canonical official genomes', () => {
        expect(getCanonicalGenomeTargetForRole('solution-architect')).toEqual({
            namespace: '@official',
            name: 'architect',
        });
        expect(getCanonicalGenomeTargetForRole('qa')).toEqual({
            namespace: '@official',
            name: 'qa-engineer',
        });
        expect(getCanonicalGenomeTargetForRole('builder')).toBeNull();
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

    it('falls back to canonical official role genome when older scores lack spec identity', () => {
        expect(resolveFeedbackUploadTarget({
            role: 'org-manager',
        })).toEqual({
            namespace: '@official',
            name: 'org-manager',
            source: 'role-fallback',
        });
    });

    it('matches legacy role-only scores against canonical feedback targets', () => {
        const target = resolveFeedbackUploadTarget({ role: 'solution-architect' });
        expect(target).not.toBeNull();
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'solution-architect' }),
            target!,
            'solution-architect',
        )).toBe(true);
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'architect', specNamespace: '@official', specName: 'architect' }),
            target!,
            'solution-architect',
        )).toBe(true);
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'master' }),
            target!,
            'solution-architect',
        )).toBe(false);
    });

    it('keeps counting legacy official-role scores after newer sessions gain explicit spec ids', () => {
        const target = resolveFeedbackUploadTarget({
            role: 'org-manager',
            specId: 'genome-org-manager',
            specNamespace: '@official',
            specName: 'org-manager',
        });
        expect(target).not.toBeNull();
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'org-manager' }),
            target!,
            'org-manager',
        )).toBe(true);
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'org-manager', specId: 'genome-org-manager' }),
            target!,
            'org-manager',
        )).toBe(true);
        expect(scoreMatchesFeedbackTarget(
            makeScore({ role: 'master' }),
            target!,
            'org-manager',
        )).toBe(false);
    });
});
