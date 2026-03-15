/**
 * fetchGenome — 从服务器拉取 GenomeSpec，支持内存缓存 + 磁盘缓存。
 *
 * 缓存策略：
 *   versioned（@ns/name:v3 或 UUID）→ 磁盘永久缓存（不可变）
 *   latest（@ns/name 无版本号）       → 内存缓存 5 分钟
 *   UUID                              → 内存缓存 5 分钟（无法确认是否最新）
 */
import axios from 'axios';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { configuration } from '@/configuration';
import { Genome, parseGenomeSpec, GenomeSpec } from '@/api/types/genome';
import { logger } from '@/ui/logger';

const memCache = new Map<string, { spec: GenomeSpec; expiresAt: number }>();
const LATEST_TTL_MS = 5 * 60 * 1000; // 5 分钟

/** 本地磁盘缓存目录 */
function diskCacheDir(): string {
    return join(configuration.ahaHomeDir, 'genomes');
}

/** versioned genome 的磁盘缓存路径，e.g. ~/.aha/genomes/@official/supervisor@v1.json */
function diskCachePath(specId: string): string | null {
    // 只对 @ns/name:version 格式做永久磁盘缓存
    const m = specId.match(/^(@[^/]+)\/([^:]+):(\d+)$/);
    if (!m) return null;
    const [, ns, name, ver] = m;
    // 去掉 @ 前缀作为目录名
    const safeNs = ns.replace('@', '');
    return join(diskCacheDir(), safeNs, `${name}@v${ver}.json`);
}

/**
 * Resolve a specId to its API URL.
 * Format 1: UUID            → /v1/genomes/:id
 * Format 2: @ns/name        → /v1/genomes/:ns/:name/latest
 * Format 3: @ns/name:N      → /v1/genomes/:ns/:name/N
 */
function resolveUrl(specId: string): string {
    const nsMatch = specId.match(/^(@[^/]+)\/([^:]+)(?::(\d+))?$/);
    if (nsMatch) {
        const [, ns, name, ver] = nsMatch;
        const encodedNs = encodeURIComponent(ns);
        return ver
            ? `${configuration.serverUrl}/v1/genomes/${encodedNs}/${name}/${ver}`
            : `${configuration.serverUrl}/v1/genomes/${encodedNs}/${name}/latest`;
    }
    return `${configuration.serverUrl}/v1/genomes/${specId}`;
}

/** 是否 versioned（可永久缓存）*/
function isVersioned(specId: string): boolean {
    return /^@[^/]+\/[^:]+:\d+$/.test(specId);
}

export async function fetchGenomeSpec(
    token: string,
    specId: string,
): Promise<GenomeSpec | null> {
    // 1. 磁盘缓存命中（仅 versioned genome）
    const diskPath = diskCachePath(specId);
    if (diskPath && existsSync(diskPath)) {
        try {
            const spec = JSON.parse(readFileSync(diskPath, 'utf-8')) as GenomeSpec;
            logger.debug(`[genome] Disk cache hit: ${specId}`);
            return spec;
        } catch {
            // 损坏的缓存文件，继续走网络
        }
    }

    // 2. 内存缓存命中
    const cached = memCache.get(specId);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.spec;
    }

    // 3. 网络请求
    try {
        const response = await axios.get<{ genome: Genome }>(
            resolveUrl(specId),
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const spec = parseGenomeSpec(response.data.genome);

        // 写磁盘缓存（versioned 永久）
        if (diskPath) {
            try {
                mkdirSync(dirname(diskPath), { recursive: true });
                writeFileSync(diskPath, JSON.stringify(spec, null, 2), 'utf-8');
                logger.debug(`[genome] Cached to disk: ${diskPath}`);
            } catch (e) {
                logger.debug(`[genome] Failed to write disk cache: ${e}`);
            }
        }

        // 写内存缓存（latest/UUID 用 TTL）
        const ttl = isVersioned(specId) ? Number.MAX_SAFE_INTEGER : Date.now() + LATEST_TTL_MS;
        memCache.set(specId, { spec, expiresAt: ttl });

        logger.debug(`[genome] Fetched ${specId}: ${response.data.genome.name}`);
        return spec;
    } catch (error) {
        logger.debug(`[genome] Failed to fetch ${specId}: ${error}`);

        // 离线降级：尝试磁盘缓存（即使 TTL 过期）
        if (diskPath && existsSync(diskPath)) {
            try {
                const spec = JSON.parse(readFileSync(diskPath, 'utf-8')) as GenomeSpec;
                logger.debug(`[genome] Offline fallback from disk: ${specId}`);
                return spec;
            } catch { /* ignore */ }
        }
        return null;
    }
}
