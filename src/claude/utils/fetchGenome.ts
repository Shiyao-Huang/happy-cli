/**
 * fetchGenome — fetches a Genome by ID from the server and caches it
 * in memory for the lifetime of the process.
 *
 * Called by runClaude when AHA_SPEC_ID is set, so the agent session is
 * configured from the server-side GenomeSpec rather than compiled defaults.
 */
import axios from 'axios';
import { configuration } from '@/configuration';
import { Genome, parseGenomeSpec, GenomeSpec } from '@/api/types/genome';
import { logger } from '@/ui/logger';

const cache = new Map<string, GenomeSpec>();

/**
 * Resolve a specId to its API URL.
 *
 * Supports two formats:
 * 1. UUID: "abc-123-def"  → GET /v1/genomes/abc-123-def
 * 2. @ns/name[:version]: "@official/supervisor:2" → GET /v1/genomes/%40official/supervisor/2
 *                         "@official/supervisor"   → GET /v1/genomes/%40official/supervisor/latest
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

export async function fetchGenomeSpec(
    token: string,
    specId: string,
): Promise<GenomeSpec | null> {
    if (cache.has(specId)) {
        return cache.get(specId)!;
    }

    try {
        const response = await axios.get<{ genome: Genome }>(
            resolveUrl(specId),
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const spec = parseGenomeSpec(response.data.genome);
        cache.set(specId, spec);
        logger.debug(`[genome] Fetched genome ${specId}: ${response.data.genome.name}`);
        return spec;
    } catch (error) {
        logger.debug(`[genome] Failed to fetch genome ${specId}: ${error}`);
        return null;
    }
}
