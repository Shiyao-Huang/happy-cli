import axios from 'axios';
import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver';
import type { DiffChange, Genome, AgentVerdict } from '@/api/types/genome';

type EntityLogRef = {
    kind: 'claude' | 'codex' | 'team' | 'daemon' | 'git' | 'browser' | 'other';
    path: string;
    sessionId?: string;
};

function genomeHubBaseUrl(): string {
    return (process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
}

function authHeaders(token?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
}

export async function createEntityTrial(args: {
    token?: string;
    namespace: string;
    name: string;
    teamId?: string;
    contextNarrative?: string;
    logRefs?: EntityLogRef[];
}): Promise<{ trial: { id: string } }> {
    const response = await axios.post(
        `${genomeHubBaseUrl()}/entities/${encodeURIComponent(args.namespace)}/${encodeURIComponent(args.name)}/trials`,
        {
            teamId: args.teamId,
            contextNarrative: args.contextNarrative,
            logRefs: args.logRefs ?? [],
        },
        { headers: authHeaders(args.token) },
    );
    return response.data as { trial: { id: string } };
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
