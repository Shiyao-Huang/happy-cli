import { configuration } from '@/configuration'
import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
import { normalizeFeedbackProxyBaseUrl } from './genomeFeedbackSync'

type FetchResponseLike = {
    ok: boolean;
    status: number;
    text(): Promise<string>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>

export type GenomePromoteTarget = {
    namespace: string;
    name: string;
}

export type GenomePromotePayload = {
    description?: string;
    spec: string;
    tags?: string;
    category?: string;
    isPublic: boolean;
    minAvgScore: number;
}

function buildPromoteHeaders(hubPublishKey?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(hubPublishKey ? { Authorization: `Bearer ${hubPublishKey}` } : {}),
    }
}

function buildServerProxyHeaders(authToken?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    }
}

async function postPromote(
    fetchImpl: FetchLike,
    hubUrl: string,
    hubPublishKey: string | undefined,
    target: GenomePromoteTarget,
    payload: GenomePromotePayload,
): Promise<FetchResponseLike> {
    return fetchImpl(
        `${hubUrl}/genomes/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/promote`,
        {
            method: 'POST',
            headers: buildPromoteHeaders(hubPublishKey),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
        },
    )
}

async function postPromoteViaServerProxy(
    fetchImpl: FetchLike,
    serverUrl: string,
    authToken: string | undefined,
    target: GenomePromoteTarget,
    payload: GenomePromotePayload,
): Promise<FetchResponseLike> {
    return fetchImpl(
        `${serverUrl}/v1/genomes/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/promote`,
        {
            method: 'POST',
            headers: buildServerProxyHeaders(authToken),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
        },
    )
}

export async function promoteGenomeViaMarketplace(args: {
    target: GenomePromoteTarget;
    payload: GenomePromotePayload;
    hubUrl?: string;
    hubPublishKey?: string;
    serverUrl?: string;
    authToken?: string;
    fetchImpl?: FetchLike;
}): Promise<{
    ok: boolean;
    status: number;
    body: string;
    transport: 'direct-hub' | 'server-proxy';
}> {
    const fetchImpl = args.fetchImpl ?? (fetch as FetchLike)
    const hubUrl = (args.hubUrl ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '')
    const rawServerUrl = args.serverUrl ?? configuration.serverUrl
    const serverUrl = normalizeFeedbackProxyBaseUrl(rawServerUrl)

    let response: FetchResponseLike | null = null
    let body = ''
    let directError: unknown = null

    try {
        response = await postPromote(fetchImpl, hubUrl, args.hubPublishKey, args.target, args.payload)
        body = await response.text().catch(() => '')
    } catch (error) {
        directError = error
    }

    const shouldTryServerProxy = Boolean(args.authToken) && (
        directError
        || !response
        || response.status === 401
        || response.status === 403
        || response.status >= 500
    )

    if (shouldTryServerProxy) {
        try {
            const proxiedResponse = await postPromoteViaServerProxy(
                fetchImpl,
                serverUrl,
                args.authToken,
                args.target,
                args.payload,
            )
            const proxiedBody = await proxiedResponse.text().catch(() => '')

            return {
                ok: proxiedResponse.ok,
                status: proxiedResponse.status,
                body: proxiedBody,
                transport: 'server-proxy',
            }
        } catch (proxyError) {
            if (!response) {
                return {
                    ok: false,
                    status: 0,
                    body: String(proxyError || directError || 'Unknown network error'),
                    transport: 'server-proxy',
                }
            }
        }
    }

    if (!response) {
        return {
            ok: false,
            status: 0,
            body: String(directError || 'Unknown network error'),
            transport: 'direct-hub',
        }
    }

    return {
        ok: response.ok,
        status: response.status,
        body,
        transport: 'direct-hub',
    }
}
