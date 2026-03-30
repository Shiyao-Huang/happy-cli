/**
 * Session → Genome Mapping
 *
 * Append-only JSONL file that links runtime sessions to their genome identity.
 * A single session runs exactly one genome, so the mapping is 1:1.
 *
 * All downstream data (team messages, help requests, scores, logs) can be
 * associated with a genome version by looking up the sessionId in this map.
 *
 * Storage: $AHA_HOME_DIR/session-genome-map.jsonl
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { configuration } from '@/configuration';

export interface SessionGenomeMapping {
    sessionId: string;
    claudeSessionId?: string;
    codexRolloutId?: string;
    teamId: string;
    specId: string;
    specRef: string;
    specVersion: number;
    runtimeType?: string;
    startedAt: number;
}

export type SessionGenomeMappingPatch = Partial<Omit<SessionGenomeMapping, 'sessionId'>>;

function getMapPath(): string {
    return join(configuration.ahaHomeDir, 'session-genome-map.jsonl');
}

function readMappings(): SessionGenomeMapping[] {
    const mapPath = getMapPath();
    if (!existsSync(mapPath)) {
        return [];
    }

    return readFileSync(mapPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as SessionGenomeMapping];
            } catch {
                return [];
            }
        });
}

function sanitizePatch(patch: SessionGenomeMappingPatch): SessionGenomeMappingPatch {
    return Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined)
    ) as SessionGenomeMappingPatch;
}

function isCompleteMapping(mapping: Partial<SessionGenomeMapping>): mapping is SessionGenomeMapping {
    return typeof mapping.sessionId === 'string'
        && typeof mapping.teamId === 'string'
        && typeof mapping.specId === 'string'
        && typeof mapping.specRef === 'string'
        && typeof mapping.specVersion === 'number'
        && typeof mapping.startedAt === 'number';
}

function sameMapping(left: SessionGenomeMapping, right: SessionGenomeMapping): boolean {
    return left.sessionId === right.sessionId
        && left.claudeSessionId === right.claudeSessionId
        && left.codexRolloutId === right.codexRolloutId
        && left.teamId === right.teamId
        && left.specId === right.specId
        && left.specRef === right.specRef
        && left.specVersion === right.specVersion
        && left.runtimeType === right.runtimeType
        && left.startedAt === right.startedAt;
}

function findLatestMapping(
    predicate: (mapping: SessionGenomeMapping) => boolean
): SessionGenomeMapping | null {
    let result: SessionGenomeMapping | null = null;

    for (const entry of readMappings()) {
        if (predicate(entry)) {
            result = entry;
        }
    }

    return result;
}

/**
 * Record a session → genome mapping. Append-only.
 */
export function recordSessionGenome(mapping: SessionGenomeMapping): void {
    const mapPath = getMapPath();
    const dir = dirname(mapPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    appendFileSync(mapPath, JSON.stringify(mapping) + '\n', 'utf-8');
}

/**
 * Look up the genome mapping for a given sessionId.
 * Returns the most recent mapping if multiple exist (e.g., after respawn).
 */
export function lookupSessionGenome(sessionId: string): SessionGenomeMapping | null {
    return findLatestMapping((entry) => entry.sessionId === sessionId);
}

/**
 * Merge a partial update into the latest mapping for a session and append it.
 * Returns null when the merged state is still incomplete.
 */
export function mergeSessionGenome(
    sessionId: string,
    patch: SessionGenomeMappingPatch
): SessionGenomeMapping | null {
    const current = lookupSessionGenome(sessionId);
    const merged: Partial<SessionGenomeMapping> = {
        ...(current ?? {}),
        sessionId,
        ...sanitizePatch(patch),
    };

    if (!isCompleteMapping(merged)) {
        return null;
    }

    if (current && sameMapping(current, merged)) {
        return current;
    }

    recordSessionGenome(merged);
    return merged;
}

/**
 * Look up by Claude local session ID (for linking Claude CC logs).
 */
export function lookupByClaudeSession(claudeSessionId: string): SessionGenomeMapping | null {
    return findLatestMapping((entry) => entry.claudeSessionId === claudeSessionId);
}

/**
 * Look up by Codex rollout ID (for linking Codex logs).
 */
export function lookupByCodexRollout(codexRolloutId: string): SessionGenomeMapping | null {
    return findLatestMapping((entry) => entry.codexRolloutId === codexRolloutId);
}

/**
 * Get all mappings for a given teamId (for team-level analysis).
 */
export function listTeamSessions(teamId: string): SessionGenomeMapping[] {
    return readMappings().filter((entry) => entry.teamId === teamId);
}
