/**
 * @module helpAutoSpawn
 * @description Automatic help-agent spawning when @help is detected in team chat.
 *
 * Polls team message JSONL files each heartbeat cycle. If any message newer than
 * the last-checked timestamp contains "@help" (case-insensitive), and the team's
 * help-agent pool has room, a help-agent is spawned via requestHelp.
 *
 * Constraints enforced:
 *   - 60 s per-team debounce: at most one spawn trigger per team per minute
 *   - Pool cap: no spawn when active help-agent count ≥ poolMax (default 2)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';

// ── Constants ─────────────────────────────────────────────────────────────────

export const HELP_POOL_MAX = 2;
export const HELP_DEBOUNCE_MS = 60_000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface TeamMessage {
  id?: string;
  teamId?: string;
  fromRole?: string;
  content: string;
  timestamp: number;
}

/** Per-team mutable state tracked across heartbeat cycles. */
export interface HelpAutoSpawnState {
  /** Last timestamp (ms) we read messages for each team. */
  lastCheckedTsByTeam: Map<string, number>;
  /** Last timestamp (ms) we triggered a help-agent spawn for each team. */
  lastSpawnTsByTeam: Map<string, number>;
}

export type RequestHelpFn = (params: {
  teamId: string;
  type: string;
  description: string;
  severity: string;
}) => Promise<{
  success: boolean;
  helpAgentSessionId?: string;
  reused?: boolean;
  saturated?: boolean;
  error?: string;
}>;

/** Session shape expected by countActiveHelpAgents (subset of TrackedSession). */
interface SessionWithMeta {
  ahaSessionMetadataFromLocalWebhook?: Metadata;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createHelpAutoSpawnState(): HelpAutoSpawnState {
  return {
    lastCheckedTsByTeam: new Map(),
    lastSpawnTsByTeam: new Map(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readTeamMessages(teamId: string, fromTs: number, cwd: string): TeamMessage[] {
  const file = path.join(cwd, '.aha', 'teams', teamId, 'messages.jsonl');
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const result: TeamMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as TeamMessage;
        if (typeof msg.timestamp === 'number' && msg.timestamp > fromTs) {
          result.push(msg);
        }
      } catch { /* skip malformed lines */ }
    }
    return result;
  } catch {
    return [];
  }
}

export function countActiveHelpAgents(
  sessions: Iterable<SessionWithMeta>,
  teamId: string
): number {
  let count = 0;
  for (const s of sessions) {
    const meta = s.ahaSessionMetadataFromLocalWebhook;
    const sessionTeamId = meta?.teamId ?? meta?.roomId;
    // Genome-first: help-agents are bypass-plane agents spawned via requestHelp.
    // The spawn path (requestHelp) sets role='help-agent' + executionPlane='bypass';
    // both come from genome, so checking either is genome-derived, not hardcoded.
    // We check role here because multiple bypass agents may exist (supervisor, help-agent)
    // and this counter specifically tracks the help-agent pool.
    if (sessionTeamId === teamId && meta?.role === 'help-agent') {
      count++;
    }
  }
  return count;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Check all active teams for @help messages and spawn help-agents as needed.
 *
 * Called once per heartbeat cycle (typically every 60 s) from run.ts.
 *
 * @param params.activeTeamIds    - All currently active team IDs to scan.
 * @param params.sessions         - Live session map values for pool counting.
 * @param params.state            - Mutable per-team debounce/check-cursor state.
 * @param params.requestHelp      - Callback to spawn/reuse a help-agent.
 * @param params.poolMax          - Max concurrent help-agents per team (default 2).
 * @param params.debounceMs       - Min ms between spawns per team (default 60 000).
 * @param params.cwd              - Working directory for .aha/teams/ (default process.cwd()).
 * @param params.now              - Injectable clock for testing (default Date.now()).
 */
export async function checkHelpAutoSpawn(params: {
  activeTeamIds: string[];
  sessions: Iterable<SessionWithMeta>;
  state: HelpAutoSpawnState;
  requestHelp: RequestHelpFn;
  poolMax?: number;
  debounceMs?: number;
  cwd?: string;
  now?: number;
}): Promise<void> {
  const {
    activeTeamIds,
    sessions,
    state,
    requestHelp,
  } = params;
  const poolMax = params.poolMax ?? HELP_POOL_MAX;
  const debounceMs = params.debounceMs ?? HELP_DEBOUNCE_MS;
  const cwd = params.cwd ?? process.cwd();
  const now = params.now ?? Date.now();

  for (const teamId of activeTeamIds) {
    const lastChecked = state.lastCheckedTsByTeam.get(teamId) ?? 0;
    const lastSpawn = state.lastSpawnTsByTeam.get(teamId) ?? 0;

    // Advance the check cursor regardless of spawn outcome
    state.lastCheckedTsByTeam.set(teamId, now);

    // Debounce: skip if we recently triggered a spawn for this team
    if (now - lastSpawn < debounceMs) {
      continue;
    }

    const messages = readTeamMessages(teamId, lastChecked, cwd);

    const hasHelpRequest = messages.some(msg =>
      typeof msg.content === 'string' && /@help/i.test(msg.content)
    );

    if (!hasHelpRequest) continue;

    // Pool cap check
    const activeHelpCount = countActiveHelpAgents(sessions, teamId);
    if (activeHelpCount >= poolMax) {
      logger.debug(
        `[HELP AUTO SPAWN] @help detected for team ${teamId} but pool is full ` +
        `(${activeHelpCount}/${poolMax}) — skipping`
      );
      continue;
    }

    logger.debug(
      `[HELP AUTO SPAWN] @help detected for team ${teamId} ` +
      `(${activeHelpCount} active, max ${poolMax}) — spawning help-agent`
    );

    // Record spawn time before the async call to prevent parallel triggers
    state.lastSpawnTsByTeam.set(teamId, now);

    try {
      const result = await requestHelp({
        teamId,
        type: 'help-request',
        description: '@help mention detected in team chat — auto-spawning help-agent',
        severity: 'medium',
      });

      if (result.success || result.reused) {
        logger.debug(
          `[HELP AUTO SPAWN] Help-agent ${result.reused ? 'reused' : 'spawned'} ` +
          `for team ${teamId}: ${result.helpAgentSessionId ?? '(no session id)'}`
        );
      } else if (result.saturated) {
        logger.debug(`[HELP AUTO SPAWN] Pool saturated for team ${teamId} after requestHelp`);
      } else {
        logger.debug(`[HELP AUTO SPAWN] requestHelp failed for team ${teamId}: ${result.error ?? 'unknown'}`);
      }
    } catch (err) {
      logger.debug(`[HELP AUTO SPAWN] Error calling requestHelp for team ${teamId}: ${err}`);
    }
  }
}
