/**
 * Hot-evolution tick factory.
 *
 * Encapsulates the per-interval version-check logic so it can be unit-tested
 * without standing up a full runClaude session.
 *
 * Contract:
 *  - If fetchFn returns null → no-op.
 *  - If latest.version <= knownVersion → no-op (skip).
 *  - If latest.version > knownVersion → update ref.current, bump knownVersion,
 *    call onVersionBump with the new image.
 *  - If fetchFn throws → log debug and swallow (no crash).
 */

import type { AgentImage } from '@/api/types/genome';
import { logger } from '@/ui/logger';

export interface HotEvolutionTickOptions {
    token: string;
    specId: string;
    agentImageRef: { current: AgentImage | null | undefined };
    initialVersion: number;
    onVersionBump: (latest: AgentImage) => void;
    fetchFn: (token: string, specId: string) => Promise<AgentImage | null>;
}

/**
 * Returns a stateful async tick function.
 * Each call checks whether the remote genome version has advanced;
 * if so, it updates agentImageRef.current and invokes onVersionBump.
 */
export function createHotEvolutionTick(opts: HotEvolutionTickOptions): () => Promise<void> {
    let knownVersion = opts.initialVersion;

    return async function tick(): Promise<void> {
        try {
            const latest = await opts.fetchFn(opts.token, opts.specId);
            if (!latest) return;
            const latestVersion = latest.version ?? 0;
            if (latestVersion > knownVersion) {
                logger.debug(
                    `[hot-evolution] Genome v${knownVersion} → v${latestVersion}, updating systemPrompt`,
                );
                opts.agentImageRef.current = latest;
                knownVersion = latestVersion;
                opts.onVersionBump(latest);
            }
        } catch (err) {
            logger.debug(`[hot-evolution] Version check skipped: ${(err as Error)?.message}`);
        }
    };
}
