import axios from 'axios';
import { normalizeGenomeHubUrl } from '@/configurationResolver';
import type { AgentPackage, DiffChange, Genome, AgentVerdict } from '@/api/types/genome';

export type EntityLogRef = {
    kind: 'claude' | 'codex' | 'team' | 'daemon' | 'git' | 'browser' | 'other';
    path: string;
    sessionId?: string;
};

function genomeHubBaseUrl(): string {
    return normalizeGenomeHubUrl();
}

function authHeaders(token?: string): Record<string, string> {
    const resolvedToken = token ?? process.env.HUB_PUBLISH_KEY ?? '';
    return {
        'Content-Type': 'application/json',
        ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
    };
}

function normalizeEntityLogRefs(logRefs?: EntityLogRef[] | string): EntityLogRef[] {
    if (!logRefs) {
        return [];
    }
    if (typeof logRefs !== 'string') {
        return logRefs;
    }

    try {
        const parsed = JSON.parse(logRefs) as unknown;
        return Array.isArray(parsed) ? parsed as EntityLogRef[] : [];
    } catch {
        return [];
    }
}

type EntityRecord = {
    id: string;
};

type EntityTrialRecord = {
    id: string;
    sessionId?: string | null;
    endedAt?: string | null;
};

async function getEntityByName(args: {
    token?: string;
    namespace: string;
    name: string;
}): Promise<EntityRecord | null> {
    try {
        const response = await axios.get(
            `${genomeHubBaseUrl()}/entities/${encodeURIComponent(args.namespace)}/${encodeURIComponent(args.name)}`,
            { headers: authHeaders(args.token) },
        );
        return (response.data as { entity?: EntityRecord }).entity ?? null;
    } catch {
        return null;
    }
}

async function listEntityTrials(args: {
    token?: string;
    entityId: string;
}): Promise<EntityTrialRecord[]> {
    try {
        const response = await axios.get(
            `${genomeHubBaseUrl()}/entities/id/${encodeURIComponent(args.entityId)}/trials`,
            { headers: authHeaders(args.token) },
        );
        return (response.data as { trials?: EntityTrialRecord[] }).trials ?? [];
    } catch {
        return [];
    }
}

export async function createEntityTrial(args: {
    token?: string;
    namespace: string;
    name: string;
    teamId?: string;
    sessionId?: string;
    contextNarrative?: string;
    logRefs?: EntityLogRef[] | string;
}): Promise<{ trial: { id: string } }> {
    const response = await axios.post(
        `${genomeHubBaseUrl()}/entities/${encodeURIComponent(args.namespace)}/${encodeURIComponent(args.name)}/trials`,
        {
            teamId: args.teamId,
            sessionId: args.sessionId,
            contextNarrative: args.contextNarrative,
            logRefs: normalizeEntityLogRefs(args.logRefs),
        },
        { headers: authHeaders(args.token) },
    );
    return response.data as { trial: { id: string } };
}

export async function ensureEntityTrial(args: {
    token?: string;
    namespace: string;
    name: string;
    teamId?: string;
    sessionId?: string;
    contextNarrative?: string;
    logRefs?: EntityLogRef[] | string;
}): Promise<{ trial: { id: string } }> {
    if (args.sessionId) {
        const entity = await getEntityByName({
            token: args.token,
            namespace: args.namespace,
            name: args.name,
        });
        if (entity?.id) {
            const trials = await listEntityTrials({
                token: args.token,
                entityId: entity.id,
            });
            const existing = trials.find((trial) =>
                trial.sessionId === args.sessionId
                && (trial.endedAt == null || trial.endedAt === '')
            );
            if (existing) {
                return { trial: { id: existing.id } };
            }
        }
    }

    return createEntityTrial(args);
}

export async function appendEntityTrialLogRefs(args: {
    token?: string;
    trialId: string;
    logRefs: EntityLogRef[];
}): Promise<void> {
    await axios.post(
        `${genomeHubBaseUrl()}/trials/${encodeURIComponent(args.trialId)}/log-refs`,
        { logRefs: args.logRefs },
        { headers: authHeaders(args.token) },
    );
}

export async function createEntityVerdict(args: {
    token?: string;
    trialId: string;
    readerRole: string;
    readerSessionId?: string;
    content: string;
    score?: number;
    action?: 'keep' | 'keep_with_guardrails' | 'mutate' | 'discard';
    dimensions?: Record<string, number>;
    contextNarrative?: string;
}): Promise<{ verdict: { id: string } }> {
    const response = await axios.post(
        `${genomeHubBaseUrl()}/trials/${encodeURIComponent(args.trialId)}/verdicts`,
        {
            readerRole: args.readerRole,
            readerSessionId: args.readerSessionId,
            content: args.content,
            score: args.score,
            action: args.action,
            dimensions: args.dimensions,
            contextNarrative: args.contextNarrative,
        },
        { headers: authHeaders(args.token) },
    );
    return response.data as { verdict: { id: string } };
}

export async function materializeEntityFeedback(args: {
    token?: string;
    entityId: string;
}): Promise<AgentVerdict> {
    const response = await axios.post(
        `${genomeHubBaseUrl()}/entities/id/${encodeURIComponent(args.entityId)}/feedback/materialize`,
        {},
        { headers: authHeaders(args.token) },
    );
    return response.data.feedback as AgentVerdict;
}

export async function submitEntityDiff(args: {
    token?: string;
    namespace: string;
    name: string;
    description: string;
    verdictRefs?: string[];
    changes: DiffChange[];
    strategy?: 'conservative' | 'moderate' | 'radical';
    authorRole?: string;
    authorSession?: string;
}): Promise<{ entity: Genome; diff: { id: string } }> {
    const response = await axios.post(
        `${genomeHubBaseUrl()}/entities/${encodeURIComponent(args.namespace)}/${encodeURIComponent(args.name)}/diffs`,
        {
            description: args.description,
            verdictRefs: args.verdictRefs,
            changes: args.changes,
            strategy: args.strategy,
            authorRole: args.authorRole,
            authorSession: args.authorSession,
        },
        { headers: authHeaders(args.token) },
    );
    return response.data as { entity: Genome; diff: { id: string } };
}

export type PackageDiffOp =
    | { type: 'manifest_set'; path: string; value: unknown }
    | { type: 'file_put'; path: string; content?: string; hash?: string }
    | { type: 'file_delete'; path: string };

export async function submitAgentPackageDiff(args: {
    token?: string;
    entityId: string;
    description: string;
    ops: PackageDiffOp[];
    baseVersion?: number;
    verdictRefs?: string[];
    strategy?: 'conservative' | 'moderate' | 'radical';
    authorRole?: string;
    authorSession?: string;
}): Promise<{ entity: Genome; diff: { id: string }; package: AgentPackage | null }> {
    const response = await axios.post(
        `${genomeHubBaseUrl()}/entities/id/${encodeURIComponent(args.entityId)}/package-diffs`,
        {
            description: args.description,
            ops: args.ops,
            baseVersion: args.baseVersion,
            verdictRefs: args.verdictRefs,
            strategy: args.strategy,
            authorRole: args.authorRole,
            authorSession: args.authorSession,
        },
        { headers: authHeaders(args.token) },
    );
    return response.data as { entity: Genome; diff: { id: string }; package: AgentPackage | null };
}
