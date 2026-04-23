import { normalizeGenomeHubUrl } from '@/configurationResolver'
/**
 * redefine 分支里的 AgentImage loader 只读 canonical entity projection。
 * 不再走 happy-server 代理，不再做离线磁盘 fallback。
 */
import axios from 'axios';
import {
    Genome,
    type AgentImage,
    type AgentPackage,
    type DiffLedgerEntry,
    hydrateAgentImageFromPackage,
    parseGenomeSpec as parseAgentImage,
} from '@/api/types/genome';
import { logger } from '@/ui/logger';
import { buildGenomeRefPath, parseGenomeRef } from '@/utils/genomeRefs';

/** Compatibility alias for canonical diff-ledger rows returned by GET /genomes/:ns/:name/ledger. */
export type AgentPlugLedgerEntry = DiffLedgerEntry;

const memCache = new Map<string, { spec: AgentImage; expiresAt: number }>();
const packageCache = new Map<string, { package: AgentPackage; expiresAt: number }>();
const blobCache = new Map<string, { content: string; expiresAt: number }>();
const LATEST_TTL_MS = 5 * 60 * 1000; // 5 分钟

function genomeHubBaseUrl(): string {
    return normalizeGenomeHubUrl();
}

function genomeCacheKey(specId: string): string {
    return `${genomeHubBaseUrl()}::${specId}`;
}

/**
 * Resolve a specId to the canonical entity API URL.
 * Format 1: UUID       → /entities/id/:id
 * Format 2: @ns/name   → /entities/:ns/:name
 * Format 3: @ns/name:N → /entities/:ns/:name/:N
 */
export function resolveEntityUrl(specId: string): string {
    const parsedRef = parseGenomeRef(specId);
    if (parsedRef) {
        return `${genomeHubBaseUrl()}${buildGenomeRefPath('entities', parsedRef)}`;
    }
    return `${genomeHubBaseUrl()}/entities/id/${encodeURIComponent(specId)}`;
}

export function resolveEntityPackageUrl(specId: string): string {
    return `${resolveEntityUrl(specId)}/package`;
}

export function resolveBlobUrl(hash: string): string {
    return `${genomeHubBaseUrl()}/blobs/${encodeURIComponent(hash)}`;
}

function authHeaders(token: string): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetch only the feedbackData string for an AgentImage / entity.
 * Returns null only for 404 (missing entity). Network / transport failures are rethrown.
 */
export async function fetchAgentVerdictData(
    token: string,
    specId: string,
): Promise<string | null> {
    const url = resolveEntityUrl(specId);
    try {
        const response = await axios.get<{ entity: Genome }>(
            url,
            {
                headers: authHeaders(token),
                validateStatus: (status) => status === 200 || status === 404,
            },
        );
        if (response.status === 404) return null;
        return response.data.entity?.feedbackData ?? null;
    } catch (error) {
        logger.debug(`[entity] Failed to fetch feedbackData for ${specId}: ${error}`);
        throw error;
    }
}

export async function fetchAgentImage(
    token: string,
    specId: string,
): Promise<AgentImage | null> {
    // redefine 分支：只保留内存缓存，不允许离线 fallback。
    const cacheKey = genomeCacheKey(specId);
    const cached = memCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.spec;
    }

    try {
        const agentPackage = await fetchAgentPackage(token, specId);
        if (agentPackage) {
            const spec = hydrateAgentImageFromPackage(agentPackage);
            memCache.set(cacheKey, { spec, expiresAt: Date.now() + LATEST_TTL_MS });
            logger.debug(`[entity-package] Fetched ${specId}: ${agentPackage.manifest.identity.name} via ${resolveEntityPackageUrl(specId)}`);
            return spec;
        }

        const url = resolveEntityUrl(specId);
        const response = await axios.get<{ entity: Genome }>(
            url,
            {
                headers: authHeaders(token),
                validateStatus: (status) => status === 200 || status === 404,
            },
        );

        if (response.status === 404) {
            return null;
        }

        const spec = parseAgentImage(response.data.entity);
        memCache.set(cacheKey, { spec, expiresAt: Date.now() + LATEST_TTL_MS });
        logger.debug(`[entity] Fetched ${specId}: ${response.data.entity.name} via ${url}`);
        return spec;
    } catch (error) {
        logger.debug(`[entity] Failed to fetch ${specId}: ${error}`);
        throw error;
    }
}

export async function fetchAgentPackage(
    token: string,
    specId: string,
): Promise<AgentPackage | null> {
    const cacheKey = genomeCacheKey(specId);
    const cached = packageCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.package;
    }

    try {
        const url = resolveEntityPackageUrl(specId);
        const response = await axios.get<{ package: AgentPackage }>(
            url,
            {
                headers: authHeaders(token),
                validateStatus: (status) => status === 200 || status === 404,
            },
        );

        if (response.status === 404) {
            return null;
        }

        const hydratedPackage = await hydratePackageBlobContent(token, response.data.package);
        packageCache.set(cacheKey, { package: hydratedPackage, expiresAt: Date.now() + LATEST_TTL_MS });
        return hydratedPackage;
    } catch (error) {
        logger.debug(`[entity-package] Failed to fetch ${specId}: ${error}`);
        throw error;
    }
}

async function hydratePackageBlobContent(
    token: string,
    agentPackage: AgentPackage,
): Promise<AgentPackage> {
    if (!agentPackage.files) {
        return agentPackage;
    }

    const hydratedEntries = await Promise.all(
        Object.entries(agentPackage.files).map(async ([path, entry]) => {
            if (typeof entry.inlineContent === 'string') {
                return [path, entry] as const;
            }
            const content = await fetchBlobContent(token, entry.hash);
            return [
                path,
                {
                    ...entry,
                    inlineContent: content,
                },
            ] as const;
        }),
    );

    return {
        ...agentPackage,
        files: Object.fromEntries(hydratedEntries),
    };
}

async function fetchBlobContent(token: string, hash: string): Promise<string> {
    const cacheKey = `${genomeHubBaseUrl()}::${hash}`;
    const cached = blobCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.content;
    }

    const response = await axios.get<{ blob: { hash: string; content: string } }>(
        resolveBlobUrl(hash),
        {
            headers: authHeaders(token),
            validateStatus: (status) => status === 200 || status === 404,
        },
    );

    if (response.status === 404) {
        throw new Error(`Blob not found: ${hash}`);
    }

    const content = response.data.blob.content;
    blobCache.set(cacheKey, { content, expiresAt: Date.now() + LATEST_TTL_MS });
    return content;
}

/**
 * Parse namespace and name from a specId in @ns/name format.
 * Returns null for UUID-format specIds.
 */
export function parseSpecIdParts(specId: string): { namespace: string; name: string } | null {
    const parsedRef = parseGenomeRef(specId);
    return parsedRef ? { namespace: parsedRef.namespace, name: parsedRef.name } : null;
}

/**
 * Fetch the ordered AgentPlug ledger for an AgentImage lineage.
 * GET /genomes/:namespace/:name/ledger
 * Returns the full ledger array (may be empty for images with no plugs yet).
 * Throws on non-404 HTTP errors.
 */
export async function fetchAgentPlugLedger(
    token: string,
    namespace: string,
    name: string,
): Promise<DiffLedgerEntry[]> {
    const url = `${genomeHubBaseUrl()}/genomes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/ledger`;
    const response = await axios.get<{ ledger: DiffLedgerEntry[] }>(
        url,
        {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: (status) => status === 200 || status === 404,
        },
    );
    if (response.status === 404) return [];
    return response.data.ledger ?? [];
}

/**
 * Fetch the immutable seed authoring document (v1 truth) for a genome lineage.
 * GET /genomes/:namespace/:name/seed
 * The payload may be canonical agent.json or a legacy compatibility projection.
 * Returns null if the entity or seed is not found.
 * Throws on non-404 HTTP errors.
 */
export async function fetchAgentImageSeed(
    token: string,
    namespace: string,
    name: string,
): Promise<Record<string, unknown> | null> {
    const url = `${genomeHubBaseUrl()}/genomes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/seed`;
    const response = await axios.get<{ seed: string }>(
        url,
        {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: (status) => status === 200 || status === 404,
        },
    );
    if (response.status === 404) return null;
    return JSON.parse(response.data.seed) as Record<string, unknown>;
}
