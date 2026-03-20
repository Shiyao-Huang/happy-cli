import type { AgentScore } from './scoreStorage';

export interface FeedbackUploadTarget {
    genomeId?: string;
    namespace: string;
    name: string;
    source: 'score-spec' | 'role-fallback';
}

const ROLE_TO_CANONICAL_GENOME = new Map<string, { namespace: string; name: string }>([
    ['master', { namespace: '@official', name: 'master' }],
    ['org-manager', { namespace: '@official', name: 'org-manager' }],
    ['researcher', { namespace: '@official', name: 'researcher' }],
    ['architect', { namespace: '@official', name: 'architect' }],
    ['solution-architect', { namespace: '@official', name: 'architect' }],
    ['implementer', { namespace: '@official', name: 'implementer' }],
    ['qa-engineer', { namespace: '@official', name: 'qa-engineer' }],
    ['qa', { namespace: '@official', name: 'qa-engineer' }],
]);

function normalizeRole(role: string | null | undefined): string {
    return (role ?? '').trim().toLowerCase();
}

export function getCanonicalGenomeTargetForRole(role: string): { namespace: string; name: string } | null {
    return ROLE_TO_CANONICAL_GENOME.get(normalizeRole(role)) ?? null;
}

export function resolveFeedbackUploadTarget(args: {
    role: string;
    specId?: string;
    specNamespace?: string;
    specName?: string;
}): FeedbackUploadTarget | null {
    if (args.specId && args.specNamespace && args.specName) {
        return {
            genomeId: args.specId,
            namespace: args.specNamespace,
            name: args.specName,
            source: 'score-spec',
        };
    }

    if (args.specId) {
        return null;
    }

    const canonical = getCanonicalGenomeTargetForRole(args.role);
    if (!canonical) {
        return null;
    }

    return {
        namespace: canonical.namespace,
        name: canonical.name,
        source: 'role-fallback',
    };
}

export function scoreMatchesFeedbackTarget(score: AgentScore, target: FeedbackUploadTarget, role: string): boolean {
    if (target.genomeId) {
        if (score.specId === target.genomeId) {
            return true;
        }

        const canonicalRoleTarget = getCanonicalGenomeTargetForRole(role);
        const canUseLegacyRoleFallback = canonicalRoleTarget
            && canonicalRoleTarget.namespace === target.namespace
            && canonicalRoleTarget.name === target.name;

        if (!canUseLegacyRoleFallback) {
            return false;
        }
    }

    if (score.specNamespace && score.specName) {
        return score.specNamespace === target.namespace && score.specName === target.name;
    }

    const scoreCanonical = getCanonicalGenomeTargetForRole(score.role);
    if (scoreCanonical) {
        return scoreCanonical.namespace === target.namespace && scoreCanonical.name === target.name;
    }

    return normalizeRole(score.role) === normalizeRole(role);
}
