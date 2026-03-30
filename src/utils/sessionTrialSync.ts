import type { SessionGenomeMapping } from '@/claude/utils/sessionGenomeMap';
import { logger } from '@/ui/logger';

export interface TrialRecord {
    id: string;
    hubEntityId: string;
    entityVersion: number;
    teamId: string | null;
    sessionId: string | null;
    contextNarrative: string | null;
    logRefs: string | null;
    startedAt: string;
    endedAt: string | null;
}

const inFlightEnsureTrialBySession = new Map<string, Promise<TrialRecord | null>>();

type SessionTrialRequest = {
    serverUrl: string;
    authToken: string;
};

type EnsureSessionTrialParams = SessionTrialRequest & {
    mapping: SessionGenomeMapping;
    contextNarrative?: string;
    logRefs?: string;
};

type CloseSessionTrialParams = SessionTrialRequest & {
    sessionId: string;
    endedAt?: string;
    contextNarrative?: string;
    logRefs?: string;
};

export function buildSessionTrialLogRefs(mapping: Pick<SessionGenomeMapping, 'sessionId' | 'runtimeType' | 'claudeSessionId' | 'codexRolloutId'>): string {
    const refs = [
        {
            kind: 'aha-session',
            sessionId: mapping.sessionId,
            runtimeType: mapping.runtimeType ?? null,
        },
        ...(mapping.claudeSessionId
            ? [{ kind: 'claude-session', sessionId: mapping.claudeSessionId }]
            : []),
        ...(mapping.codexRolloutId
            ? [{ kind: 'codex-rollout', sessionId: mapping.codexRolloutId }]
            : []),
    ];

    return JSON.stringify(refs);
}

async function fetchJson<T>(input: string | URL, init: RequestInit): Promise<T | null> {
    try {
        const res = await fetch(input, {
            ...init,
            signal: init.signal ?? AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
            return null;
        }
        return await res.json() as T;
    } catch (error) {
        logger.debug(`[session-trial] Request failed: ${String(error)}`);
        return null;
    }
}

export async function findSessionTrial(params: SessionTrialRequest & { sessionId: string }): Promise<TrialRecord | null> {
    const data = await fetchJson<{ trials?: TrialRecord[] }>(
        `${params.serverUrl}/v1/trials?sessionId=${encodeURIComponent(params.sessionId)}&limit=1`,
        {
            headers: {
                'Authorization': `Bearer ${params.authToken}`,
            },
        },
    );

    return data?.trials?.[0] ?? null;
}

export async function ensureSessionTrial(params: EnsureSessionTrialParams): Promise<TrialRecord | null> {
    if (!params.mapping.specId || !params.mapping.specVersion) {
        return null;
    }

    const sessionId = params.mapping.sessionId;
    const inFlight = inFlightEnsureTrialBySession.get(sessionId);
    if (inFlight) {
        return await inFlight;
    }

    const request = (async () => {
        const existing = await findSessionTrial({
            serverUrl: params.serverUrl,
            authToken: params.authToken,
            sessionId,
        });
        if (existing) {
            return existing;
        }

        const data = await fetchJson<{ trial?: TrialRecord }>(
            `${params.serverUrl}/v1/trials`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${params.authToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    hubEntityId: params.mapping.specId,
                    entityVersion: params.mapping.specVersion,
                    teamId: params.mapping.teamId,
                    sessionId,
                    contextNarrative: params.contextNarrative,
                    logRefs: params.logRefs ?? buildSessionTrialLogRefs(params.mapping),
                }),
            },
        );

        return data?.trial ?? null;
    })();

    inFlightEnsureTrialBySession.set(sessionId, request);
    try {
        return await request;
    } finally {
        if (inFlightEnsureTrialBySession.get(sessionId) === request) {
            inFlightEnsureTrialBySession.delete(sessionId);
        }
    }
}

export async function closeSessionTrial(params: CloseSessionTrialParams): Promise<TrialRecord | null> {
    const trial = await findSessionTrial({
        serverUrl: params.serverUrl,
        authToken: params.authToken,
        sessionId: params.sessionId,
    });
    if (!trial) {
        return null;
    }

    const data = await fetchJson<{ trial?: TrialRecord }>(
        `${params.serverUrl}/v1/trials/${encodeURIComponent(trial.id)}`,
        {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${params.authToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                endedAt: params.endedAt ?? new Date().toISOString(),
                contextNarrative: params.contextNarrative,
                logRefs: params.logRefs,
            }),
        },
    );

    return data?.trial ?? null;
}
