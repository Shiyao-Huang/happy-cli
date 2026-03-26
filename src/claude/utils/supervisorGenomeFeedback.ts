import type { AgentScore } from './scoreStorage';

export interface FeedbackUploadTarget {
    genomeId?: string;
    namespace: string;
    name: string;
    source: 'score-spec' | 'explicit-target';
}

const ROLE_TO_CANONICAL_GENOME = new Map<string, { namespace: string; name: string }>([
    ['master', { namespace: '@official', name: 'master' }],
    ['org-manager', { namespace: '@official', name: 'org-manager' }],
    ['supervisor', { namespace: '@official', name: 'supervisor' }],
    ['help-agent', { namespace: '@official', name: 'help-agent' }],
    ['researcher', { namespace: '@official', name: 'researcher' }],
    ['scout', { namespace: '@official', name: 'researcher' }],
    ['builder', { namespace: '@official', name: 'implementer' }],
    ['framer', { namespace: '@official', name: 'implementer' }],
    ['architect', { namespace: '@official', name: 'architect' }],
    ['solution-architect', { namespace: '@official', name: 'architect' }],
    ['implementer', { namespace: '@official', name: 'implementer' }],
    ['reviewer', { namespace: '@official', name: 'qa-engineer' }],
    ['qa-engineer', { namespace: '@official', name: 'qa-engineer' }],
    ['qa', { namespace: '@official', name: 'qa-engineer' }],
]);

function normalizeRole(role: string | null | undefined): string {
    return (role ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s*\(.*?\)\s*/g, ' ')
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
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

    if (args.specNamespace && args.specName) {
        return {
            namespace: args.specNamespace,
            name: args.specName,
            source: 'explicit-target',
        };
    }
    return null;
}

export function scoreMatchesFeedbackTarget(score: AgentScore, target: FeedbackUploadTarget): boolean {
    if (target.genomeId) {
        return score.specId === target.genomeId;
    }

    if (score.specNamespace && score.specName) {
        return score.specNamespace === target.namespace && score.specName === target.name;
    }
    return false;
}
