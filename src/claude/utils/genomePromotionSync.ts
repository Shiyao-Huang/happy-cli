import { configuration } from '@/configuration'
import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
import type { DiffChange } from '@/api/types/genome'
import { normalizeFeedbackProxyBaseUrl } from './genomeFeedbackSync'
import { resolveGenomeHubWriteTokenSync } from '@/utils/genomeHubAuth'

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
    const hubAuthToken = resolveGenomeHubWriteTokenSync(hubPublishKey)
    return {
        'Content-Type': 'application/json',
        ...(hubAuthToken ? { Authorization: `Bearer ${hubAuthToken}` } : {}),
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

export type GenomeCreateHubPayload = {
    namespace: string;
    name: string;
    version?: number;
    description?: string;
    spec: string;
    isPublic?: boolean;
    category?: string;
    tags?: string;
}

async function postCreateHub(
    fetchImpl: FetchLike,
    hubUrl: string,
    hubPublishKey: string | undefined,
    payload: GenomeCreateHubPayload,
): Promise<FetchResponseLike> {
    return fetchImpl(
        `${hubUrl}/genomes`,
        {
            method: 'POST',
            headers: buildPromoteHeaders(hubPublishKey),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        },
    )
}

async function postCreateHubViaServerProxy(
    fetchImpl: FetchLike,
    serverUrl: string,
    authToken: string | undefined,
    payload: GenomeCreateHubPayload,
): Promise<FetchResponseLike> {
    return fetchImpl(
        `${serverUrl}/v1/genomes/hub-create`,
        {
            method: 'POST',
            headers: buildServerProxyHeaders(authToken),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        },
    )
}

/**
 * Create a new genome version in genome-hub, with automatic fallback to the
 * happy-server proxy (`POST /v1/genomes/hub-create`) when direct hub access
 * returns 401/403 or fails entirely.  Used by `mutate_genome` MCP tool.
 */
export async function createGenomeViaMarketplace(args: {
    payload: GenomeCreateHubPayload;
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
        response = await postCreateHub(fetchImpl, hubUrl, args.hubPublishKey, args.payload)
        body = await response.text().catch(() => '')
    } catch (error) {
        directError = error
    }

    const shouldTryServerProxy = Boolean(args.authToken) && (
        directError
        || !response
        || response.status === 401
        || response.status === 403
        || response.status === 404
        || response.status >= 500
    )

    if (shouldTryServerProxy) {
        try {
            const proxiedResponse = await postCreateHubViaServerProxy(
                fetchImpl,
                serverUrl,
                args.authToken,
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

// ── Diff submit helpers (for evolve_genome proxy fallback) ──────────

type DiffSubmitPayload = {
    description: string;
    changes: DiffChange[];
    verdictRefs?: string[];
    strategy?: string;
    authorRole?: string;
    authorSession?: string;
};

export type PackageDiffOp =
    | { type: 'manifest_set'; path: string; value: unknown }
    | { type: 'file_put'; path: string; content?: string; hash?: string }
    | { type: 'file_delete'; path: string };

type PackageDiffSubmitPayload = {
    description: string;
    ops: PackageDiffOp[];
    baseVersion?: number;
    verdictRefs?: string[];
    strategy?: string;
    authorRole?: string;
    authorSession?: string;
};

async function postDiffDirect(
    fetchImpl: FetchLike,
    hubUrl: string,
    hubPublishKey: string | undefined,
    namespace: string,
    name: string,
    payload: DiffSubmitPayload,
): Promise<FetchResponseLike> {
    return fetchImpl(
        `${hubUrl}/genomes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/diff`,
        {
            method: 'POST',
            headers: buildPromoteHeaders(hubPublishKey),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        },
    );
}

async function postDiffViaServerProxy(
    fetchImpl: FetchLike,
    serverUrl: string,
    authToken: string | undefined,
    namespace: string,
    name: string,
    payload: DiffSubmitPayload,
): Promise<FetchResponseLike> {
    return fetchImpl(
        `${serverUrl}/v1/genomes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/diff`,
        {
            method: 'POST',
            headers: buildServerProxyHeaders(authToken),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        },
    );
}

async function postPackageDiffDirect(
    fetchImpl: FetchLike,
    hubUrl: string,
    hubPublishKey: string | undefined,
    entityId: string,
    payload: PackageDiffSubmitPayload,
): Promise<FetchResponseLike> {
    return fetchImpl(
        `${hubUrl}/entities/id/${encodeURIComponent(entityId)}/package-diffs`,
        {
            method: 'POST',
            headers: buildPromoteHeaders(hubPublishKey),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        },
    );
}

/**
 * Submit a diff to genome-hub for evolve_genome, with automatic fallback
 * to the happy-server proxy (`POST /v1/genomes/:ns/:name/diff`) when direct
 * hub access returns 401/403 or fails entirely.
 */
export async function submitDiffViaMarketplace(args: {
    namespace: string;
    name: string;
    payload: DiffSubmitPayload;
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
    const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
    const hubUrl = (args.hubUrl ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const rawServerUrl = args.serverUrl ?? configuration.serverUrl;
    const serverUrl = normalizeFeedbackProxyBaseUrl(rawServerUrl);

    let response: FetchResponseLike | null = null;
    let body = '';
    let directError: unknown = null;

    try {
        response = await postDiffDirect(fetchImpl, hubUrl, args.hubPublishKey, args.namespace, args.name, args.payload);
        body = await response.text().catch(() => '');
    } catch (error) {
        directError = error;
    }

    const shouldTryServerProxy = Boolean(args.authToken) && (
        directError
        || !response
        || response.status === 401
        || response.status === 403
        || response.status === 404
        || response.status >= 500
    );

    if (shouldTryServerProxy) {
        try {
            const proxiedResponse = await postDiffViaServerProxy(
                fetchImpl,
                serverUrl,
                args.authToken,
                args.namespace,
                args.name,
                args.payload,
            );
            const proxiedBody = await proxiedResponse.text().catch(() => '');

            return {
                ok: proxiedResponse.ok,
                status: proxiedResponse.status,
                body: proxiedBody,
                transport: 'server-proxy',
            };
        } catch (proxyError) {
            if (!response) {
                return {
                    ok: false,
                    status: 0,
                    body: String(proxyError || directError || 'Unknown network error'),
                    transport: 'server-proxy',
                };
            }
        }
    }

    if (!response) {
        return {
            ok: false,
            status: 0,
            body: String(directError || 'Unknown network error'),
            transport: 'direct-hub',
        };
    }

    return {
        ok: response.ok,
        status: response.status,
        body,
        transport: 'direct-hub',
    };
}

export async function submitPackageDiffViaMarketplace(args: {
    entityId: string;
    payload: PackageDiffSubmitPayload;
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
    const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
    const hubUrl = (args.hubUrl ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const rawServerUrl = args.serverUrl ?? configuration.serverUrl;
    const serverUrl = normalizeFeedbackProxyBaseUrl(rawServerUrl);

    let response: FetchResponseLike | null = null;
    let body = '';
    let directError: unknown = null;

    try {
        response = await postPackageDiffDirect(fetchImpl, hubUrl, args.hubPublishKey, args.entityId, args.payload);
        body = await response.text().catch(() => '');
    } catch (error) {
        directError = error;
    }

    // Fallback to server proxy when direct hub access fails
    const shouldTryServerProxy = Boolean(args.authToken) && (
        directError
        || !response
        || response.status === 401
        || response.status === 403
        || response.status === 404
        || response.status >= 500
    );

    if (shouldTryServerProxy) {
        try {
            const proxiedResponse = await fetchImpl(
                `${serverUrl}/v1/genomes/id/${encodeURIComponent(args.entityId)}/package-diffs`,
                {
                    method: 'POST',
                    headers: buildServerProxyHeaders(args.authToken),
                    body: JSON.stringify(args.payload),
                    signal: AbortSignal.timeout(10_000),
                },
            );
            const proxiedBody = await proxiedResponse.text().catch(() => '');

            return {
                ok: proxiedResponse.ok,
                status: proxiedResponse.status,
                body: proxiedBody,
                transport: 'server-proxy',
            };
        } catch (proxyError) {
            if (!response) {
                return {
                    ok: false,
                    status: 0,
                    body: String(proxyError || directError || 'Unknown network error'),
                    transport: 'server-proxy',
                };
            }
        }
    }

    if (!response) {
        return {
            ok: false,
            status: 0,
            body: String(directError || 'Unknown network error'),
            transport: 'direct-hub',
        };
    }

    return {
        ok: response.ok,
        status: response.status,
        body,
        transport: 'direct-hub',
    };
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
        || response.status === 404
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
