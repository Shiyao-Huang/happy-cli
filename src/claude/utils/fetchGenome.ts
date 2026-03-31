import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
/**
 * redefine 分支里的 AgentImage loader 只读 canonical entity projection。
 * 不再走 happy-server 代理，不再做离线磁盘 fallback。
 */
import axios from 'axios';
import { Genome, type AgentImage, type DiffLedgerEntry, parseGenomeSpec as parseAgentImage } from '@/api/types/genome';
import { logger } from '@/ui/logger';

/** Compatibility alias for canonical diff-ledger rows returned by GET /genomes/:ns/:name/ledger. */
export type AgentPlugLedgerEntry = DiffLedgerEntry;

const memCache = new Map<string, { spec: AgentImage; expiresAt: number }>();
const LATEST_TTL_MS = 5 * 60 * 1000; // 5 分钟

function genomeHubBaseUrl(): string {
    return (process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
}

/**
 * Resolve a specId to the canonical entity API URL.
 * Format 1: UUID       → /entities/id/:id
 * Format 2: @ns/name   → /entities/:ns/:name
 * Format 3: @ns/name:N → /entities/:ns/:name/:N
 */
export function resolveEntityUrl(specId: string): string {
    const nsMatch = specId.match(/^(@[^/]+)\/([^:]+)(?::(\d+))?$/);
    if (nsMatch) {
        const [, ns, name, ver] = nsMatch;
        const encodedNs = encodeURIComponent(ns);
        return ver
            ? `${genomeHubBaseUrl()}/entities/${encodedNs}/${name}/${ver}`
            : `${genomeHubBaseUrl()}/entities/${encodedNs}/${name}`;
    }
    return `${genomeHubBaseUrl()}/entities/id/${encodeURIComponent(specId)}`;
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
                headers: { Authorization: `Bearer ${token}` },
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
    const cached = memCache.get(specId);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.spec;
    }

    try {
        const url = resolveEntityUrl(specId);
        const response = await axios.get<{ entity: Genome }>(
            url,
            {
                headers: { Authorization: `Bearer ${token}` },
                validateStatus: (status) => status === 200 || status === 404,
            },
        );

        if (response.status === 404) {
            return null;
        }

        const spec = parseAgentImage(response.data.entity);
        memCache.set(specId, { spec, expiresAt: Date.now() + LATEST_TTL_MS });
        logger.debug(`[entity] Fetched ${specId}: ${response.data.entity.name} via ${url}`);
        return spec;
    } catch (error) {
        logger.debug(`[entity] Failed to fetch ${specId}: ${error}`);
        throw error;
    }
}

/**
 * Parse namespace and name from a specId in @ns/name format.
 * Returns null for UUID-format specIds.
 */
export function parseSpecIdParts(specId: string): { namespace: string; name: string } | null {
    const nsMatch = specId.match(/^(@[^/]+)\/([^:]+)(?::(\d+))?$/);
    if (nsMatch) {
        return { namespace: nsMatch[1], name: nsMatch[2] };
    }
    return null;
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
