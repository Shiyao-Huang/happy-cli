/**
 * @module supervisorScheduler
 * @description Periodic supervisor lifecycle management: spawn, idle-retire, pending-action retry.
 *
 * ```mermaid
 * graph TD
 *   A[run.ts] -->|runSupervisorCycle| B[supervisorScheduler]
 *   B -->|spawnSession| C[sessionManager]
 *   B -->|requestHelp| C
 *   B -->|reads| D[pidToTrackedSession]
 *   B -->|supervisorState| E[supervisorState]
 *   B -->|resolveSystemGenomeId| F[genome-hub / happy-server]
 * ```
 *
 * ## Exports
 * - `SupervisorContext` — inputs required by a single supervisor cycle
 * - `collectLiveMainlineSessionIdsByTeam` — helper used by both scheduler and heartbeat
 * - `runSupervisorCycle` — execute one tick of the supervisor scheduling loop
 */

import axios from 'axios';

import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { TrackedSession } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import {
  getPendingActionRetryDelayMs,
  listSupervisorStates,
  readSupervisorState,
  SUPERVISOR_PENDING_ACTION_MAX_RETRIES,
  updateSupervisorRun,
  updateSupervisorState,
} from './supervisorState';

// ── Context type ───────────────────────────────────────────────────────────────

export interface SupervisorContext {
  /** Live session map (read from sessionManager) */
  pidToTrackedSession: Map<number, TrackedSession>;
  /** Current heartbeat tick counter (incremented by caller before calling this) */
  heartbeatCount: number;
  /** How many heartbeat ticks between supervisor spawns (default 20) */
  supervisorInterval: number;
  /** How many ms of inactivity before a supervisor is auto-terminated */
  supervisorTerminateIdleMs: number;
  /** Effective base retry interval for pending actions (≥ heartbeatIntervalMs) */
  pendingActionBaseRetryMs: number;
  /** The heartbeat interval in ms (used to compute stale-state threshold) */
  heartbeatIntervalMs: number;
  /** Credentials used to authenticate genome-hub / happy-server calls */
  credentialsToken: string;
  /** Spawn a new session */
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  /** Spawn a help-agent for a team */
  requestHelp: (params: {
    teamId: string;
    sessionId?: string;
    type: string;
    description: string;
    severity: string;
  }) => Promise<{ success: boolean; helpAgentSessionId?: string; error?: string }>;
}

// ── Shared helper ──────────────────────────────────────────────────────────────

/**
 * Build a map of teamId → Set<ahaSessionId> for all live mainline sessions
 * (excludes supervisor and help-agent roles).
 *
 * This helper is used by both supervisorScheduler and the heartbeat cycle in run.ts.
 */
export function collectLiveMainlineSessionIdsByTeam(
  pidToTrackedSession: Map<number, TrackedSession>
): Map<string, Set<string>> {
  const sessionsByTeam = new Map<string, Set<string>>();

  for (const session of pidToTrackedSession.values()) {
    const meta = session.ahaSessionMetadataFromLocalWebhook;
    const sessionTeamId = meta?.teamId || meta?.roomId;
    if (!sessionTeamId || !session.ahaSessionId) continue;
    if (meta?.role === 'supervisor' || meta?.role === 'help-agent') continue;

    const teamSessions = sessionsByTeam.get(sessionTeamId) ?? new Set<string>();
    teamSessions.add(session.ahaSessionId);
    sessionsByTeam.set(sessionTeamId, teamSessions);
  }

  return sessionsByTeam;
}

// ── Genome resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the specId of a @official genome by name.
 * Queries genome-hub first (M3 marketplace), falls back to happy-server (M2 legacy).
 * Returns null on failure — caller falls back to hardcoded role.
 */
async function resolveSystemGenomeId(name: string, credentialsToken: string): Promise<string | null> {
  const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';

  try {
    const res = await axios.get(
      `${hubUrl}/genomes/%40official/${name}`,
      { timeout: 5000 }
    );
    const id = res.data?.genome?.id ?? null;
    if (id) return id;
  } catch { /* fall through to legacy */ }

  try {
    const res = await axios.get(
      `${configuration.serverUrl}/v1/genomes/%40official/${name}/latest`,
      { headers: { Authorization: `Bearer ${credentialsToken}` }, timeout: 5000 }
    );
    return res.data?.genome?.id ?? null;
  } catch {
    return null;
  }
}

// ── Supervisor cycle ───────────────────────────────────────────────────────────

/**
 * Execute one tick of the supervisor scheduling loop.
 *
 * Steps:
 * 1. Compute live mainline sessions by team
 * 2. For each supervisor state: check idle-terminate, process pending actions
 * 3. On supervisor interval: spawn supervisor agents for active teams (singleton guard)
 */
export async function runSupervisorCycle(ctx: SupervisorContext): Promise<void> {
  const {
    pidToTrackedSession,
    heartbeatCount,
    supervisorInterval,
    supervisorTerminateIdleMs,
    pendingActionBaseRetryMs,
    heartbeatIntervalMs,
    credentialsToken,
    spawnSession,
    requestHelp,
  } = ctx;

  const liveMainlineSessionIdsByTeam = collectLiveMainlineSessionIdsByTeam(pidToTrackedSession);
  const supervisorStates = listSupervisorStates();
  const now = Date.now();

  // ── Per-team supervisor state processing ────────────────────────────────────
  for (const supervisorState of supervisorStates) {
    const liveSessionIds = liveMainlineSessionIdsByTeam.get(supervisorState.teamId) ?? new Set<string>();

    // Auto-terminate if no live sessions and idle timeout has elapsed
    if (
      !supervisorState.terminated &&
      liveSessionIds.size === 0 &&
      supervisorState.lastRunAt > 0 &&
      (now - supervisorState.lastRunAt) > supervisorTerminateIdleMs
    ) {
      await updateSupervisorState(supervisorState.teamId, (state) => ({
        ...state,
        terminated: true,
        pendingAction: null,
        pendingActionMeta: null,
      }));
      logger.debug(`[SUPERVISOR SCHEDULER] Marked supervisor state terminated for inactive team ${supervisorState.teamId}`);
      continue;
    }

    // Skip terminated teams or teams without a notify_help pending action
    if (supervisorState.terminated || supervisorState.pendingAction?.type !== 'notify_help') {
      continue;
    }

    const pendingAction = supervisorState.pendingAction;
    const pendingActionMeta = supervisorState.pendingActionMeta ?? {
      retryCount: 0,
      lastAttemptAt: 0,
      nextRetryAt: 0,
      lastError: null,
    };

    // If the target session is no longer live, clear the pending action
    if (pendingAction.targetSessionId && !liveSessionIds.has(pendingAction.targetSessionId)) {
      await updateSupervisorState(supervisorState.teamId, (state) => ({
        ...state,
        pendingAction: null,
        pendingActionMeta: null,
      }));
      logger.debug(
        `[SUPERVISOR SCHEDULER] Cleared pendingAction for team ${supervisorState.teamId}; ` +
        `target session ${pendingAction.targetSessionId} is no longer live`
      );
      continue;
    }

    // No target and no live sessions → nothing to do
    if (!pendingAction.targetSessionId && liveSessionIds.size === 0) {
      continue;
    }

    // Exhausted retries → clear
    if (pendingActionMeta.retryCount >= SUPERVISOR_PENDING_ACTION_MAX_RETRIES) {
      await updateSupervisorState(supervisorState.teamId, (state) => ({
        ...state,
        pendingAction: null,
        pendingActionMeta: null,
      }));
      logger.debug(`[SUPERVISOR SCHEDULER] Cleared exhausted pendingAction for team ${supervisorState.teamId}`);
      continue;
    }

    // Not yet time to retry
    if (pendingActionMeta.nextRetryAt > now) {
      continue;
    }

    // Attempt the help spawn
    const result = await requestHelp({
      teamId: supervisorState.teamId,
      sessionId: pendingAction.targetSessionId,
      type: pendingAction.requestType || 'custom',
      description: pendingAction.description || pendingAction.message,
      severity: pendingAction.severity || 'high',
    });

    if (result.success) {
      await updateSupervisorState(supervisorState.teamId, (state) => ({
        ...state,
        pendingAction: null,
        pendingActionMeta: null,
      }));
      logger.debug(`[SUPERVISOR SCHEDULER] Retried pendingAction successfully for team ${supervisorState.teamId}`);
      continue;
    }

    const nextRetryCount = pendingActionMeta.retryCount + 1;
    if (nextRetryCount >= SUPERVISOR_PENDING_ACTION_MAX_RETRIES) {
      await updateSupervisorState(supervisorState.teamId, (state) => ({
        ...state,
        pendingAction: null,
        pendingActionMeta: null,
      }));
      logger.debug(
        `[SUPERVISOR SCHEDULER] pendingAction retries exhausted for team ${supervisorState.teamId}: ` +
        `${result.error || 'unknown error'}`
      );
      continue;
    }

    await updateSupervisorState(supervisorState.teamId, (state) => ({
      ...state,
      pendingActionMeta: {
        retryCount: nextRetryCount,
        lastAttemptAt: now,
        nextRetryAt: now + getPendingActionRetryDelayMs(nextRetryCount, pendingActionBaseRetryMs),
        lastError: result.error || 'unknown error',
      },
    }));
    logger.debug(
      `[SUPERVISOR SCHEDULER] pendingAction retry ${nextRetryCount}/${SUPERVISOR_PENDING_ACTION_MAX_RETRIES} ` +
      `failed for team ${supervisorState.teamId}: ${result.error || 'unknown error'}`
    );
  }

  // ── Supervisor spawn check (every N heartbeats) ─────────────────────────────
  if (heartbeatCount % supervisorInterval !== 0 || liveMainlineSessionIdsByTeam.size === 0) {
    return;
  }

  const activeTeamIds = new Set<string>(liveMainlineSessionIdsByTeam.keys());

  for (const teamId of activeTeamIds) {
    const supervisorState = readSupervisorState(teamId);

    if (supervisorState.terminated) {
      logger.debug(`[SUPERVISOR SCHEDULER] Skipping supervisor for terminated team ${teamId}`);
      continue;
    }

    // Singleton guard: use persisted PID to detect running supervisor across daemon restarts
    if (supervisorState.lastSupervisorPid > 0) {
      try {
        process.kill(supervisorState.lastSupervisorPid, 0); // liveness check
        logger.debug(
          `[SUPERVISOR SCHEDULER] Supervisor already running (PID ${supervisorState.lastSupervisorPid}) for team ${teamId}, skipping`
        );
        continue;
      } catch {
        logger.debug(
          `[SUPERVISOR SCHEDULER] Previous supervisor PID ${supervisorState.lastSupervisorPid} is gone ` +
          `for team ${teamId}, will spawn new one`
        );
      }
    }

    // Auto-retire after too many idle runs
    const maxIdleRuns = parseInt(process.env.AHA_SUPERVISOR_MAX_IDLE || '6');
    if (supervisorState.idleRuns >= maxIdleRuns) {
      logger.debug(
        `[SUPERVISOR SCHEDULER] Supervisor idle for ${supervisorState.idleRuns} runs on team ${teamId}, marking terminated`
      );
      await updateSupervisorState(teamId, (state) => ({ ...state, terminated: true }));
      continue;
    }

    logger.debug(
      `[SUPERVISOR SCHEDULER] Supervisor check triggered (heartbeat #${heartbeatCount}, ` +
      `team ${teamId}, cursor=${supervisorState.teamLogCursor})`
    );

    // Detect idle runs: state unchanged since last trigger
    const heartbeatMs = heartbeatIntervalMs * supervisorInterval;
    const stateIsStale =
      supervisorState.lastRunAt > 0 &&
      (Date.now() - supervisorState.lastRunAt) > heartbeatMs * 1.5;
    if (stateIsStale) {
      await updateSupervisorRun(teamId, { idleRuns: supervisorState.idleRuns + 1 });
      logger.debug(
        `[SUPERVISOR SCHEDULER] Supervisor idle run detected for team ${teamId}, idleRuns now ${supervisorState.idleRuns + 1}`
      );
    }

    try {
      // Resolve @official/supervisor genome specId from genome-hub
      const supervisorSpecId = await resolveSystemGenomeId('supervisor', credentialsToken);
      if (!supervisorSpecId) {
        if (process.env.AHA_GENOME_FALLBACK !== '1') {
          console.warn(
            `[GENOME] ⚠️  supervisor genome not found in genome-hub — spawning without DNA.\n` +
            `         Ensure genome-hub is running (GENOME_HUB_URL=${process.env.GENOME_HUB_URL ?? 'http://localhost:3006'})\n` +
            `         and @official/supervisor is seeded. (Set AHA_GENOME_FALLBACK=1 to silence.)`
          );
        }
      } else {
        logger.debug(`[SUPERVISOR SCHEDULER] Supervisor genome specId: ${supervisorSpecId}`);
      }

      const supervisorResult = await spawnSession({
        directory: configuration.ahaHomeDir,
        agent: 'claude',
        teamId,
        role: 'supervisor',
        sessionName: 'Supervisor',
        executionPlane: 'bypass',
        specId: supervisorSpecId ?? undefined,
        env: {
          AHA_SUPERVISOR_TEAM_LOG_CURSOR: String(supervisorState.teamLogCursor),
          AHA_SUPERVISOR_CC_LOG_CURSORS: JSON.stringify(supervisorState.ccLogCursors),
          AHA_SUPERVISOR_CODEX_HISTORY_CURSOR: String(supervisorState.codexHistoryCursor),
          AHA_SUPERVISOR_CODEX_SESSION_CURSORS: JSON.stringify(supervisorState.codexSessionCursors),
          AHA_SUPERVISOR_LAST_CONCLUSION: supervisorState.lastConclusion,
          AHA_SUPERVISOR_LAST_SESSION_ID: supervisorState.lastSessionId || '',
          AHA_SUPERVISOR_PENDING_ACTION: supervisorState.pendingAction
            ? JSON.stringify(supervisorState.pendingAction)
            : '',
        },
        // Persist PID immediately on fork — before the webhook arrives — so the singleton
        // guard works even if the webhook times out or the daemon restarts.
        onPidKnown: (pid) => {
          void updateSupervisorRun(teamId, { lastSupervisorPid: pid })
            .then(() => {
              logger.debug(`[SUPERVISOR SCHEDULER] Persisted supervisor PID ${pid} for team ${teamId} (pre-webhook)`);
            })
            .catch((error) => {
              logger.debug(`[SUPERVISOR SCHEDULER] Failed to persist supervisor PID for team ${teamId}`, error);
            });
        },
      });

      if (supervisorResult.type === 'success') {
        logger.debug(`[SUPERVISOR SCHEDULER] Supervisor agent spawned: ${supervisorResult.sessionId}`);
      }
    } catch (e) {
      logger.debug(`[SUPERVISOR SCHEDULER] Failed to spawn supervisor: ${e}`);
    }
  }
}
