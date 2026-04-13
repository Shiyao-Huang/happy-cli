import axios from 'axios';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configuration } from '@/configuration';
import { readPublishKeyFromSettings } from '@/configurationResolver';

export type GenomeHubTokenSource =
    | 'explicit'
    | 'env-auth-token'
    | 'cache'
    | 'server-issued'
    | 'env-publish-key'
    | 'settings-publish-key'
    | 'none';

export type GenomeHubTokenCacheEntry = {
    token: string;
    expiresAt: number;
    fetchedAt: number;
    serverUrl?: string;
};

export const GENOME_HUB_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

let inFlightGenomeHubTokenRefresh: Promise<GenomeHubTokenCacheEntry | null> | null = null;

function normalizeExpiryMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1_000_000_000_000 ? value : value * 1000;
    }
    if (typeof value === 'string') {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && value.trim() !== '') {
            return normalizeExpiryMs(numeric);
        }
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

export function decodeJwtExpiryMs(token: string): number | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
        return normalizeExpiryMs(payload.exp);
    } catch {
        return null;
    }
}

function isTokenUsable(token: string | undefined, minTtlMs: number, nowMs: number): boolean {
    if (!token) return false;
    const expiresAt = decodeJwtExpiryMs(token);
    if (expiresAt == null) {
        return true;
    }
    return expiresAt > nowMs + minTtlMs;
}

function normalizeCacheEntry(raw: unknown): GenomeHubTokenCacheEntry | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const candidate = raw as Partial<GenomeHubTokenCacheEntry> & {
        genomeToken?: unknown;
        fetchedAt?: unknown;
        expiresAt?: unknown;
        serverUrl?: unknown;
    };
    const token = typeof candidate.token === 'string'
        ? candidate.token
        : typeof candidate.genomeToken === 'string'
            ? candidate.genomeToken
            : null;
    if (!token) {
        return null;
    }

    const expiresAt = normalizeExpiryMs(candidate.expiresAt) ?? decodeJwtExpiryMs(token);
    if (expiresAt == null) {
        return null;
    }

    return {
        token,
        expiresAt,
        fetchedAt: normalizeExpiryMs(candidate.fetchedAt) ?? Date.now(),
        ...(typeof candidate.serverUrl === 'string' ? { serverUrl: candidate.serverUrl } : {}),
    };
}

function readTokenCacheSync(cacheFile: string): GenomeHubTokenCacheEntry | null {
    if (!existsSync(cacheFile)) {
        return null;
    }

    try {
        return normalizeCacheEntry(JSON.parse(readFileSync(cacheFile, 'utf8')));
    } catch {
        return null;
    }
}

export function readCachedGenomeHubTokenSync(options?: {
    cacheFile?: string;
    minTtlMs?: number;
    nowMs?: number;
}): GenomeHubTokenCacheEntry | null {
    const cacheFile = options?.cacheFile ?? configuration.genomeHubTokenCacheFile;
    const minTtlMs = options?.minTtlMs ?? 0;
    const nowMs = options?.nowMs ?? Date.now();
    const cached = readTokenCacheSync(cacheFile);

    if (!cached) {
        return null;
    }

    if (!isTokenUsable(cached.token, minTtlMs, nowMs)) {
        return null;
    }

    return cached;
}

export function resolveDynamicGenomeHubWriteTokenSync(options?: {
    minTtlMs?: number;
    nowMs?: number;
    cacheFile?: string;
}): { token: string; source: Extract<GenomeHubTokenSource, 'env-auth-token' | 'cache'>; expiresAt?: number } | null {
    const minTtlMs = options?.minTtlMs ?? 0;
    const nowMs = options?.nowMs ?? Date.now();
    const envToken = process.env.GENOME_HUB_AUTH_TOKEN;

    if (isTokenUsable(envToken, minTtlMs, nowMs)) {
        return {
            token: envToken!,
            source: 'env-auth-token',
            ...(decodeJwtExpiryMs(envToken!) != null ? { expiresAt: decodeJwtExpiryMs(envToken!)! } : {}),
        };
    }

    const cached = readCachedGenomeHubTokenSync(options);
    if (cached) {
        return {
            token: cached.token,
            source: 'cache',
            expiresAt: cached.expiresAt,
        };
    }

    return null;
}

export function resolveGenomeHubWriteTokenSync(
    explicitToken?: string,
    options?: {
        minTtlMs?: number;
        nowMs?: number;
        cacheFile?: string;
    },
): string | undefined {
    const minTtlMs = options?.minTtlMs ?? 0;
    const nowMs = options?.nowMs ?? Date.now();

    if (isTokenUsable(explicitToken, minTtlMs, nowMs)) {
        return explicitToken;
    }

    const dynamic = resolveDynamicGenomeHubWriteTokenSync(options);
    if (dynamic) {
        return dynamic.token;
    }

    const envPublishKey = process.env.HUB_PUBLISH_KEY;
    if (isTokenUsable(envPublishKey, minTtlMs, nowMs)) {
        return envPublishKey;
    }

    const settingsPublishKey = readPublishKeyFromSettings(configuration.settingsFile);
    if (isTokenUsable(settingsPublishKey, minTtlMs, nowMs)) {
        return settingsPublishKey;
    }

    return undefined;
}

async function writeGenomeHubTokenCache(entry: GenomeHubTokenCacheEntry, cacheFile: string): Promise<void> {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(entry, null, 2));
}

export async function clearGenomeHubTokenCache(cacheFile: string = configuration.genomeHubTokenCacheFile): Promise<void> {
    delete process.env.GENOME_HUB_AUTH_TOKEN;
    await unlink(cacheFile).catch(() => {});
}

function parseIssuedGenomeToken(data: unknown): GenomeHubTokenCacheEntry | null {
    if (!data || typeof data !== 'object') {
        return null;
    }

    const payload = data as Record<string, unknown>;
    const token = typeof payload.genomeToken === 'string'
        ? payload.genomeToken
        : typeof payload.token === 'string'
            ? payload.token
            : typeof payload.accessToken === 'string'
                ? payload.accessToken
                : null;
    if (!token) {
        return null;
    }

    const expiresAt = normalizeExpiryMs(payload.expiresAt)
        ?? normalizeExpiryMs(payload.exp)
        ?? (typeof payload.expiresIn === 'number' ? Date.now() + payload.expiresIn * 1000 : null)
        ?? decodeJwtExpiryMs(token);

    if (expiresAt == null) {
        return null;
    }

    return {
        token,
        expiresAt,
        fetchedAt: Date.now(),
        ...(typeof payload.serverUrl === 'string' ? { serverUrl: payload.serverUrl } : {}),
    };
}

async function fetchGenomeHubTokenFromServer(args: {
    authToken: string;
    serverUrl: string;
    cacheFile: string;
}): Promise<GenomeHubTokenCacheEntry | null> {
    const response = await axios.post(
        `${args.serverUrl.replace(/\/$/, '')}/v1/genome-token`,
        {},
        {
            headers: {
                Authorization: `Bearer ${args.authToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );

    const parsed = parseIssuedGenomeToken(response.data);
    if (!parsed) {
        throw new Error('genome-token endpoint returned an invalid payload');
    }

    const entry: GenomeHubTokenCacheEntry = {
        ...parsed,
        serverUrl: args.serverUrl,
    };
    process.env.GENOME_HUB_AUTH_TOKEN = entry.token;
    await writeGenomeHubTokenCache(entry, args.cacheFile);
    return entry;
}

export async function ensureGenomeHubWriteToken(args: {
    authToken?: string;
    serverUrl?: string;
    minTtlMs?: number;
    forceRefresh?: boolean;
    cacheFile?: string;
} = {}): Promise<{
    token?: string;
    source: GenomeHubTokenSource;
    expiresAt?: number;
}> {
    const minTtlMs = args.minTtlMs ?? GENOME_HUB_TOKEN_REFRESH_SKEW_MS;
    const cacheFile = args.cacheFile ?? configuration.genomeHubTokenCacheFile;
    const serverUrl = args.serverUrl ?? configuration.serverUrl;

    if (!args.forceRefresh) {
        const dynamic = resolveDynamicGenomeHubWriteTokenSync({ cacheFile, minTtlMs });
        if (dynamic) {
            return dynamic;
        }
    }

    if (args.authToken) {
        try {
            if (!inFlightGenomeHubTokenRefresh) {
                inFlightGenomeHubTokenRefresh = fetchGenomeHubTokenFromServer({
                    authToken: args.authToken,
                    serverUrl,
                    cacheFile,
                }).finally(() => {
                    inFlightGenomeHubTokenRefresh = null;
                });
            }

            const refreshed = await inFlightGenomeHubTokenRefresh;
            if (refreshed) {
                return {
                    token: refreshed.token,
                    source: 'server-issued',
                    expiresAt: refreshed.expiresAt,
                };
            }
        } catch {
            // Fall through to legacy fallback below.
        }
    }

    const envPublishKey = process.env.HUB_PUBLISH_KEY;
    if (envPublishKey) {
        return { token: envPublishKey, source: 'env-publish-key' };
    }

    const settingsPublishKey = readPublishKeyFromSettings(configuration.settingsFile);
    if (settingsPublishKey) {
        return { token: settingsPublishKey, source: 'settings-publish-key' };
    }

    return { source: 'none' };
}
