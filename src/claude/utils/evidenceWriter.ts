import { normalizeFeedbackProxyBaseUrl } from './genomeFeedbackSync';
import {
    createEntityVerdict,
    ensureEntityTrial,
    type EntityLogRef,
} from './entityHub';

type FetchResponseLike = {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

type ProxyEntityRecord = {
    id: string;
};

type ProxyTrialRecord = {
    id: string;
    sessionId?: string | null;
    endedAt?: string | null;
};

type VerdictAction = 'keep' | 'keep_with_guardrails' | 'mutate' | 'discard';

export type EvidenceWriteTransport = 'direct-hub' | 'server-proxy';

function buildServerProxyHeaders(authToken?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };
}

function normalizeEntityLogRefs(logRefs?: EntityLogRef[] | string): EntityLogRef[] {
    if (!logRefs) {
        return [];
    }
    if (!Array.isArray(logRefs)) {
        try {
            const parsed = JSON.parse(logRefs) as unknown;
            return Array.isArray(parsed) ? parsed as EntityLogRef[] : [];
        } catch {
            return [];
        }
    }
    return logRefs;
}

function extractErrorMessage(data: unknown, fallback: string): string {
    if (data && typeof data === 'object') {
        const candidate = (data as { error?: unknown; message?: unknown });
        if (typeof candidate.error === 'string' && candidate.error.trim()) {
            return candidate.error;
        }
        if (typeof candidate.message === 'string' && candidate.message.trim()) {
            return candidate.message;
        }
    }
    return fallback;
}

async function readJsonSafe<T>(response: FetchResponseLike): Promise<T | null> {
    try {
        return await response.json() as T;
    } catch {
        return null;
    }
}

async function ensureEntityTrialViaServerProxy(args: {
    fetchImpl: FetchLike;
    serverUrl: string;
    authToken?: string;
    namespace: string;
    name: string;
    teamId?: string;
    sessionId?: string;
    contextNarrative?: string;
    logRefs?: EntityLogRef[] | string;
}): Promise<{ trial: { id: string } }> {
    const headers = buildServerProxyHeaders(args.authToken);
    const encodedNamespace = encodeURIComponent(args.namespace);
    const encodedName = encodeURIComponent(args.name);

    const entityResponse = await args.fetchImpl(
        `${args.serverUrl}/v1/entities/${encodedNamespace}/${encodedName}`,
        {
            headers,
            signal: AbortSignal.timeout(10_000),
        },
    );
    const entityPayload = await readJsonSafe<{ entity?: ProxyEntityRecord }>(entityResponse);
    if (!entityResponse.ok || !entityPayload?.entity?.id) {
        throw new Error(extractErrorMessage(entityPayload, `Failed to resolve entity ${args.namespace}/${args.name} via server proxy (${entityResponse.status})`));
    }

    if (args.sessionId) {
        const trialsResponse = await args.fetchImpl(
            `${args.serverUrl}/v1/entities/id/${encodeURIComponent(entityPayload.entity.id)}/trials`,
            {
                headers,
                signal: AbortSignal.timeout(10_000),
            },
        );
        const trialsPayload = await readJsonSafe<{ trials?: ProxyTrialRecord[] }>(trialsResponse);
        if (!trialsResponse.ok) {
            throw new Error(extractErrorMessage(trialsPayload, `Failed to list entity trials via server proxy (${trialsResponse.status})`));
        }

        const existing = (trialsPayload?.trials ?? []).find((trial) =>
            trial.sessionId === args.sessionId
            && (trial.endedAt == null || trial.endedAt === '')
        );
        if (existing?.id) {
            return { trial: { id: existing.id } };
        }
    }

    const createTrialResponse = await args.fetchImpl(
        `${args.serverUrl}/v1/entities/${encodedNamespace}/${encodedName}/trials`,
        {
            method: 'POST',
            headers,
            body: JSON.stringify({
                teamId: args.teamId,
                sessionId: args.sessionId,
                contextNarrative: args.contextNarrative,
                logRefs: normalizeEntityLogRefs(args.logRefs),
            }),
            signal: AbortSignal.timeout(10_000),
        },
    );
    const createTrialPayload = await readJsonSafe<{ trial?: { id?: string } }>(createTrialResponse);
    if (!createTrialResponse.ok || !createTrialPayload?.trial?.id) {
        throw new Error(extractErrorMessage(createTrialPayload, `Failed to create entity trial via server proxy (${createTrialResponse.status})`));
    }

    return { trial: { id: createTrialPayload.trial.id } };
}

async function createEntityVerdictViaServerProxy(args: {
    fetchImpl: FetchLike;
    serverUrl: string;
    authToken?: string;
    trialId: string;
    readerRole: string;
    readerSessionId?: string;
    content: string;
    score?: number;
    action?: VerdictAction;
    dimensions?: Record<string, number>;
    contextNarrative?: string;
}): Promise<{ verdict: { id: string } }> {
    const response = await args.fetchImpl(
        `${args.serverUrl}/v1/trials/${encodeURIComponent(args.trialId)}/verdicts`,
        {
            method: 'POST',
            headers: buildServerProxyHeaders(args.authToken),
            body: JSON.stringify({
                readerRole: args.readerRole,
                readerSessionId: args.readerSessionId,
                content: args.content,
                score: args.score,
                action: args.action,
                dimensions: args.dimensions,
                contextNarrative: args.contextNarrative,
            }),
            signal: AbortSignal.timeout(10_000),
        },
    );
    const payload = await readJsonSafe<{ verdict?: { id?: string } }>(response);
    if (!response.ok || !payload?.verdict?.id) {
        throw new Error(extractErrorMessage(payload, `Failed to create entity verdict via server proxy (${response.status})`));
    }

    return { verdict: { id: payload.verdict.id } };
}

export async function writeEntityVerdict(args: {
    namespace: string;
    name: string;
    teamId?: string;
    sessionId?: string;
    contextNarrative?: string;
    logRefs?: EntityLogRef[] | string;
    readerRole: string;
    readerSessionId?: string;
    content: string;
    score?: number;
    action?: VerdictAction;
    dimensions?: Record<string, number>;
    hubPublishKey?: string;
    serverUrl?: string;
    authToken?: string;
    fetchImpl?: FetchLike;
}): Promise<{
    trialId: string;
    verdictId: string;
    transport: EvidenceWriteTransport;
}> {
    try {
        const trialResult = await ensureEntityTrial({
            token: args.hubPublishKey,
            namespace: args.namespace,
            name: args.name,
            teamId: args.teamId,
            sessionId: args.sessionId,
            contextNarrative: args.contextNarrative,
            logRefs: args.logRefs,
        });
        const verdictResult = await createEntityVerdict({
            token: args.hubPublishKey,
            trialId: trialResult.trial.id,
            readerRole: args.readerRole,
            readerSessionId: args.readerSessionId,
            content: args.content,
            score: args.score,
            action: args.action,
            dimensions: args.dimensions,
        });

        return {
            trialId: trialResult.trial.id,
            verdictId: verdictResult.verdict.id,
            transport: 'direct-hub',
        };
    } catch (directError) {
        if (!args.authToken || !args.serverUrl) {
            throw directError;
        }

        const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
        const serverUrl = normalizeFeedbackProxyBaseUrl(args.serverUrl);
        const trialResult = await ensureEntityTrialViaServerProxy({
            fetchImpl,
            serverUrl,
            authToken: args.authToken,
            namespace: args.namespace,
            name: args.name,
            teamId: args.teamId,
            sessionId: args.sessionId,
            contextNarrative: args.contextNarrative,
            logRefs: args.logRefs,
        });
        const verdictResult = await createEntityVerdictViaServerProxy({
            fetchImpl,
            serverUrl,
            authToken: args.authToken,
            trialId: trialResult.trial.id,
            readerRole: args.readerRole,
            readerSessionId: args.readerSessionId,
            content: args.content,
            score: args.score,
            action: args.action,
            dimensions: args.dimensions,
        });

        return {
            trialId: trialResult.trial.id,
            verdictId: verdictResult.verdict.id,
            transport: 'server-proxy',
        };
    }
}
