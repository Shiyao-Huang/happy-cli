import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
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
import { stopSession } from './sessionManager';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import {
  getPendingActionRetryDelayMs,
  listSupervisorStates,
  readSupervisorState,
  SUPERVISOR_PENDING_ACTION_MAX_RETRIES,
  updateSupervisorRun,
  updateSupervisorState,
} from './supervisorState';

interface TeamOutstandingWorkSummary {
  teamId: string;
  unfinishedTaskCount: number;
  blockedTaskCount: number;
  status: 'has_work' | 'no_work' | 'unknown';
}

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
  }) => Promise<{ success: boolean; helpAgentSessionId?: string; reused?: boolean; saturated?: boolean; error?: string }>;
}

// ── Shared helper ──────────────────────────────────────────────────────────────

/**
 * Build a map of teamId → Set<ahaSessionId> for all live mainline sessions
 * (excludes supervisor and help-agent roles).
 *
 * This helper is used by both supervisorScheduler and the heartbeat cycle in run.ts.
 */
/**
 * Collect mainline session IDs grouped by team — used for lifecycle decisions.
 *
 * This set EXCLUDES bypass agents. Used for:
 * - team liveness / idle-terminate (team is "active" only if mainline agents exist)
 * - task routing (bypass agents don't execute implementation tasks)
 * - cwd resolution (bypass agents don't represent project paths)
 * - spawn guard (bypass agents have their own scheduler)
 */
export function collectLiveMainlineSessionIdsByTeam(
  pidToTrackedSession: Map<number, TrackedSession>
): Map<string, Set<string>> {
  const sessionsByTeam = new Map<string, Set<string>>();

  for (const session of pidToTrackedSession.values()) {
    const meta = session.ahaSessionMetadataFromLocalWebhook;
    const sessionTeamId = meta?.teamId || meta?.roomId;
    if (!sessionTeamId || !session.ahaSessionId) continue;
    // Exclude bypass from lifecycle set
    if (meta?.executionPlane === 'bypass') continue;

    const teamSessions = sessionsByTeam.get(sessionTeamId) ?? new Set<string>();
    teamSessions.add(session.ahaSessionId);
    sessionsByTeam.set(sessionTeamId, teamSessions);
  }

  return sessionsByTeam;
}

/**
 * Collect ALL evaluable session IDs grouped by team — used for scoring.
 *
 * Self-referential design: bypass agents (supervisor, help-agent) are ALSO
 * evaluable targets. If excluded from scoring, they can never receive verdicts
 * and therefore can never evolve — breaking the self-referential loop.
 *
 * Supervisor's own running session is excluded at score_agent call time,
 * not here.
 */
export function collectEvaluableSessionIdsByTeam(
  pidToTrackedSession: Map<number, TrackedSession>
): Map<string, Set<string>> {
  const sessionsByTeam = new Map<string, Set<string>>();

  for (const session of pidToTrackedSession.values()) {
    const meta = session.ahaSessionMetadataFromLocalWebhook;
    const sessionTeamId = meta?.teamId || meta?.roomId;
    if (!sessionTeamId || !session.ahaSessionId) continue;

    const teamSessions = sessionsByTeam.get(sessionTeamId) ?? new Set<string>();
    teamSessions.add(session.ahaSessionId);
    sessionsByTeam.set(sessionTeamId, teamSessions);
  }

  return sessionsByTeam;
}

/**
 * Resolve the best working directory for bypass agents on a team.
 *
 * We prefer the project path reported by a live mainline team member so
 * supervisors/help-agents inherit the real repo context instead of the daemon's
 * private aha home directory. If no trustworthy mainline path exists, fall back
 * to the daemon process cwd.
 */
export function resolveTeamWorkingDirectory(
  teamId: string,
  pidToTrackedSession: Map<number, TrackedSession>
): string {
  const candidates = Array.from(pidToTrackedSession.values())
    .filter((session) => {
      const meta = session.ahaSessionMetadataFromLocalWebhook;
      const sessionTeamId = meta?.teamId || meta?.roomId;
      if (sessionTeamId !== teamId) return false;
      if (!session.ahaSessionId) return false;
      // Genome-first: executionPlane is the canonical field for bypass agents.
      if (meta?.executionPlane === 'bypass') return false;

      const candidatePath = meta?.path?.trim();
      return Boolean(candidatePath) && candidatePath !== configuration.ahaHomeDir;
    })
    .sort((left, right) => {
      const leftStartedAt = left.ahaSessionMetadataFromLocalWebhook?.processStartedAt ?? 0;
      const rightStartedAt = right.ahaSessionMetadataFromLocalWebhook?.processStartedAt ?? 0;
      if (rightStartedAt !== leftStartedAt) return rightStartedAt - leftStartedAt;
      return right.pid - left.pid;
    });

  const resolvedPath = candidates[0]?.ahaSessionMetadataFromLocalWebhook?.path?.trim();
  if (resolvedPath) {
    return resolvedPath;
  }

  return process.cwd();
}

// ── Genome resolution ──────────────────────────────────────────────────────────

interface ResolvedGenome {
  specId: string;
  spec: Record<string, unknown> | null;
}

/**
 * Resolve the specId (and optionally parsed spec) of a @official genome by name.
 * Queries genome-hub first (M3 marketplace), falls back to happy-server (M2 legacy).
 * Returns null on failure — caller falls back to hardcoded role.
 */
async function resolveSystemGenome(name: string, credentialsToken: string): Promise<ResolvedGenome | null> {
  const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;

  try {
    const res = await axios.get(
      `${hubUrl}/genomes/%40official/${name}`,
      { timeout: 5000 }
    );
    const id = res.data?.genome?.id ?? null;
    if (id) {
      let spec: Record<string, unknown> | null = null;
      try {
        const rawSpec = res.data?.genome?.spec;
        spec = typeof rawSpec === 'string' ? JSON.parse(rawSpec) : rawSpec ?? null;
      } catch { /* spec parse failure is non-fatal */ }
      return { specId: id, spec };
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.error(`[DEV] Genome Hub API failed for ${name}:`, error);
      throw new Error(`Genome Hub API broken - fix before using legacy fallback: ${String(error)}`);
    }
    logger.warn(`[PROD] Genome Hub API failed for ${name}, falling back to legacy`, error);
  }

  try {
    const res = await axios.get(
      `${configuration.serverUrl}/v1/genomes/%40official/${name}/latest`,
      { headers: { Authorization: `Bearer ${credentialsToken}` }, timeout: 5000 }
    );
    const id = res.data?.genome?.id ?? null;
    if (id) {
      let spec: Record<string, unknown> | null = null;
      try {
        const rawSpec = res.data?.genome?.spec;
        spec = typeof rawSpec === 'string' ? JSON.parse(rawSpec) : rawSpec ?? null;
      } catch { /* spec parse failure is non-fatal */ }
      return { specId: id, spec };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the specId of a @official genome by name.
 * Queries genome-hub first (M3 marketplace), falls back to happy-server (M2 legacy).
 * Returns null on failure — caller falls back to hardcoded role.
 */
async function resolveSystemGenomeId(name: string, credentialsToken: string): Promise<string | null> {
  const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;

  try {
    const res = await axios.get(
      `${hubUrl}/genomes/%40official/${name}`,
      { timeout: 5000 }
    );
    const id = res.data?.genome?.id ?? null;
    if (id) return id;
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.error(`[DEV] Genome Hub API failed for ${name}:`, error);
      throw new Error(`Genome Hub API broken - fix before using legacy fallback: ${String(error)}`);
    }
    logger.warn(`[PROD] Genome Hub API failed for ${name}, falling back to legacy`, error);
  }

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

function getServerAuthHeaders(credentialsToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credentialsToken}`,
  };
}

async function fetchOutstandingWorkSummary(
  teamId: string,
  credentialsToken: string,
): Promise<TeamOutstandingWorkSummary> {
  try {
    const res = await axios.get(
      `${configuration.serverUrl}/v1/teams/${teamId}/tasks`,
      {
        headers: getServerAuthHeaders(credentialsToken),
        timeout: 5000,
      }
    );

    const tasks = Array.isArray(res.data?.tasks) ? res.data.tasks : [];
    const unfinishedTasks = tasks.filter((task: { status?: string }) => task?.status !== 'done');
    const blockedTaskCount = unfinishedTasks.filter((task: { status?: string }) => task?.status === 'blocked').length;

    return {
      teamId,
      unfinishedTaskCount: unfinishedTasks.length,
      blockedTaskCount,
      status: unfinishedTasks.length > 0 ? 'has_work' : 'no_work',
    };
  } catch (error) {
    logger.debug(
      `[SUPERVISOR SCHEDULER] Failed to fetch task summary for team ${teamId}: ` +
      `${error instanceof Error ? error.message : 'unknown error'}`
    );
    return {
      teamId,
      unfinishedTaskCount: 0,
      blockedTaskCount: 0,
      status: 'unknown',
    };
  }
}

async function listTeamsWithOutstandingWork(credentialsToken: string): Promise<Map<string, TeamOutstandingWorkSummary>> {
  try {
    const res = await axios.get(
      `${configuration.serverUrl}/v1/teams`,
      {
        headers: getServerAuthHeaders(credentialsToken),
        timeout: 5000,
      }
    );

    const teams = Array.isArray(res.data?.teams) ? res.data.teams : [];
    const candidateTeams = teams
      .filter((team: { id?: string; taskCount?: number }) => typeof team?.id === 'string' && (team.taskCount ?? 0) > 0)
      .map((team: { id: string }) => team.id);

    const summaries = await Promise.all(
      candidateTeams.map((teamId: string) => fetchOutstandingWorkSummary(teamId, credentialsToken))
    );

    return new Map(
      summaries
        .filter((summary) => summary.status === 'has_work')
        .map((summary) => [summary.teamId, summary] as const)
    );
  } catch (error) {
    logger.debug(
      `[SUPERVISOR SCHEDULER] Failed to list teams for outstanding work scan: ` +
      `${error instanceof Error ? error.message : 'unknown error'}`
    );
    return new Map();
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
  const outstandingWorkByKnownTeam = new Map<string, TeamOutstandingWorkSummary>();
  const now = Date.now();

  // Force-kill supervisors that have been terminated for >5 minutes (zombie cleanup)
  const forceKillTimeoutMs = parseInt(process.env.AHA_SUPERVISOR_FORCE_KILL_TIMEOUT_MS || '300000', 10); // 5 minutes
  for (const supervisorState of supervisorStates) {
    if (
      supervisorState.terminated &&
      supervisorState.terminatedAt > 0 &&
      supervisorState.lastSupervisorPid > 0 &&
      (now - supervisorState.terminatedAt) > forceKillTimeoutMs
    ) {
      try {
        process.kill(supervisorState.lastSupervisorPid, 0); // Check if process still exists
        // Process is still alive after timeout, force kill it
        process.kill(supervisorState.lastSupervisorPid, 'SIGKILL');
        logger.debug(
          `[SUPERVISOR SCHEDULER] Force-killed zombie supervisor PID ${supervisorState.lastSupervisorPid} ` +
          `for team ${supervisorState.teamId} (terminated for ${Math.round((now - supervisorState.terminatedAt) / 1000)}s)`
        );
        await updateSupervisorRun(supervisorState.teamId, { lastSupervisorPid: 0 });
      } catch {
        // Process doesn't exist or already killed, clean up PID
        if (supervisorState.lastSupervisorPid > 0) {
          await updateSupervisorRun(supervisorState.teamId, { lastSupervisorPid: 0 });
        }
      }
    }
  }

  for (const supervisorState of supervisorStates) {
    outstandingWorkByKnownTeam.set(
      supervisorState.teamId,
      await fetchOutstandingWorkSummary(supervisorState.teamId, credentialsToken)
    );
  }

  // ── Per-team supervisor state processing ────────────────────────────────────
  for (const supervisorState of supervisorStates) {
    const liveSessionIds = liveMainlineSessionIdsByTeam.get(supervisorState.teamId) ?? new Set<string>();
    const outstandingWork = outstandingWorkByKnownTeam.get(supervisorState.teamId);
    const workStatus = outstandingWork?.status ?? 'unknown';
    const hasOutstandingWork = workStatus === 'has_work';

    // Auto-terminate if no live sessions and idle timeout has elapsed
    if (
      !supervisorState.terminated &&
      liveSessionIds.size === 0 &&
      workStatus === 'no_work' &&
      supervisorState.lastRunAt > 0 &&
      (now - supervisorState.lastRunAt) > supervisorTerminateIdleMs
    ) {
      await updateSupervisorState(supervisorState.teamId, (state) => ({
        ...state,
        terminated: true,
        terminatedAt: Date.now(),
        pendingAction: null,
        pendingActionMeta: null,
      }));
      // Stop the running supervisor process if alive
      if (supervisorState.lastSupervisorPid > 0) {
        try {
          process.kill(supervisorState.lastSupervisorPid, 0); // liveness check
          if (supervisorState.lastSessionId) {
            stopSession(supervisorState.lastSessionId);
          } else {
            process.kill(supervisorState.lastSupervisorPid, 'SIGTERM');
          }
          await updateSupervisorRun(supervisorState.teamId, { lastSupervisorPid: 0 });
          logger.debug(
            `[SUPERVISOR SCHEDULER] Stopped supervisor PID ${supervisorState.lastSupervisorPid} ` +
            `(session ${supervisorState.lastSessionId}) for inactive team ${supervisorState.teamId}`
          );
        } catch {
          // PID already dead, just clear it
          await updateSupervisorRun(supervisorState.teamId, { lastSupervisorPid: 0 });
        }
      }
      logger.debug(`[SUPERVISOR SCHEDULER] Marked supervisor state terminated for inactive team ${supervisorState.teamId}`);
      continue;
    }

    if (supervisorState.terminated && hasOutstandingWork) {
      await updateSupervisorState(supervisorState.teamId, (state) => ({
        ...state,
        terminated: false,
        terminatedAt: 0,
      }));
      logger.debug(
        `[SUPERVISOR SCHEDULER] Revived terminated supervisor state for team ${supervisorState.teamId} ` +
        `because ${outstandingWork?.unfinishedTaskCount ?? 0} unfinished task(s) remain`
      );
    }

    // Skip terminated teams or teams without a notify_help pending action
    if ((supervisorState.terminated && workStatus !== 'has_work') || supervisorState.pendingAction?.type !== 'notify_help') {
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

    const unresolvedSaturatedReuse = result.success && result.reused && result.saturated;

    if (result.success && !unresolvedSaturatedReuse) {
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
        `${unresolvedSaturatedReuse ? 'help-agent reuse remained saturated' : result.error || 'unknown error'}`
      );
      continue;
    }

    await updateSupervisorState(supervisorState.teamId, (state) => ({
      ...state,
      pendingActionMeta: {
        retryCount: nextRetryCount,
        lastAttemptAt: now,
        nextRetryAt: now + getPendingActionRetryDelayMs(nextRetryCount, pendingActionBaseRetryMs),
        lastError: unresolvedSaturatedReuse
          ? `help-agent ${result.helpAgentSessionId ?? 'unknown'} reused but saturated`
          : result.error || 'unknown error',
      },
    }));
    logger.debug(
      `[SUPERVISOR SCHEDULER] pendingAction retry ${nextRetryCount}/${SUPERVISOR_PENDING_ACTION_MAX_RETRIES} ` +
      `failed for team ${supervisorState.teamId}: ${unresolvedSaturatedReuse ? 'help-agent reuse remained saturated' : result.error || 'unknown error'}`
    );
  }

  // ── Supervisor spawn check (every N heartbeats) ─────────────────────────────
  if (heartbeatCount % supervisorInterval !== 0) {
    return;
  }

  const teamsWithOutstandingWork = await listTeamsWithOutstandingWork(credentialsToken);
  const activeTeamIds = new Set<string>([
    ...liveMainlineSessionIdsByTeam.keys(),
    ...teamsWithOutstandingWork.keys(),
  ]);

  if (activeTeamIds.size === 0) {
    return;
  }

  for (const teamId of activeTeamIds) {
    const supervisorState = readSupervisorState(teamId);
    const hasLiveMainlineAgents = (liveMainlineSessionIdsByTeam.get(teamId)?.size ?? 0) > 0;
    const outstandingWork = teamsWithOutstandingWork.get(teamId)
      ?? outstandingWorkByKnownTeam.get(teamId)
      ?? { teamId, unfinishedTaskCount: 0, blockedTaskCount: 0, status: 'unknown' as const };
    const workStatus = outstandingWork.status;

    if (!hasLiveMainlineAgents && workStatus !== 'has_work') {
      continue;
    }

    if (supervisorState.terminated && workStatus !== 'has_work') {
      logger.debug(`[SUPERVISOR SCHEDULER] Skipping supervisor for terminated team ${teamId}`);
      continue;
    }

    if (supervisorState.terminated && workStatus === 'has_work') {
      await updateSupervisorState(teamId, (state) => ({
        ...state,
        terminated: false,
        terminatedAt: 0,
      }));
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
      if (workStatus === 'has_work') {
        await updateSupervisorState(teamId, (state) => ({
          ...state,
          idleRuns: 0,
          terminated: false,
          terminatedAt: 0,
        }));
        logger.debug(
          `[SUPERVISOR SCHEDULER] Keeping supervisor eligible for team ${teamId} ` +
          `because ${outstandingWork.unfinishedTaskCount} unfinished task(s) remain`
        );
      } else if (workStatus === 'unknown') {
        logger.debug(
          `[SUPERVISOR SCHEDULER] Not terminating supervisor for team ${teamId} ` +
          `because outstanding work state is unknown`
        );
        continue;
      } else {
        logger.debug(
          `[SUPERVISOR SCHEDULER] Supervisor idle for ${supervisorState.idleRuns} runs on team ${teamId}, marking terminated`
        );
        await updateSupervisorState(teamId, (state) => ({ ...state, terminated: true, terminatedAt: Date.now() }));
        // Safety: stop any lingering supervisor process
        if (supervisorState.lastSupervisorPid > 0) {
          try {
            process.kill(supervisorState.lastSupervisorPid, 0);
            if (supervisorState.lastSessionId) {
              stopSession(supervisorState.lastSessionId);
            } else {
              process.kill(supervisorState.lastSupervisorPid, 'SIGTERM');
            }
            await updateSupervisorRun(teamId, { lastSupervisorPid: 0 });
          } catch {
            await updateSupervisorRun(teamId, { lastSupervisorPid: 0 });
          }
        }
        continue;
      }
    }

    logger.debug(
      `[SUPERVISOR SCHEDULER] Supervisor check triggered (heartbeat #${heartbeatCount}, ` +
      `team ${teamId}, cursor=${supervisorState.teamLogCursor}, ` +
      `liveMainline=${hasLiveMainlineAgents}, unfinishedTasks=${outstandingWork.unfinishedTaskCount})`
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
          logger.warn(
            `[GENOME] ⚠️  supervisor genome not found in genome-hub — spawning without DNA.\n` +
            `         Ensure genome-hub is running (GENOME_HUB_URL=${process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL})\n` +
            `         and @official/supervisor is seeded. (Set AHA_GENOME_FALLBACK=1 to silence.)`
          );
        }
      } else {
        logger.debug(`[SUPERVISOR SCHEDULER] Supervisor genome specId: ${supervisorSpecId}`);
      }

      const supervisorDirectory = resolveTeamWorkingDirectory(teamId, pidToTrackedSession);
      if (supervisorDirectory === process.cwd()) {
        logger.debug(
          `[SUPERVISOR SCHEDULER] No trusted team project path found for ${teamId}; falling back to daemon cwd ${supervisorDirectory}`
        );
      } else {
        logger.debug(
          `[SUPERVISOR SCHEDULER] Using team project cwd ${supervisorDirectory} for supervisor on team ${teamId}`
        );
      }

      const supervisorResult = await spawnSession({
        directory: supervisorDirectory,
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

      if (supervisorResult.type === 'success' || supervisorResult.type === 'queued') {
        logger.debug(
          `[SUPERVISOR SCHEDULER] Supervisor agent accepted: ${supervisorResult.sessionId}` +
          (supervisorResult.type === 'queued' ? ` (queued at position ${supervisorResult.queuePosition})` : '')
        );
      } else if (supervisorResult.type === 'pending') {
        logger.debug(
          `[SUPERVISOR SCHEDULER] Supervisor process started and is awaiting webhook binding: ${supervisorResult.pendingSessionId} (pid=${supervisorResult.pid})`
        );
      }
    } catch (e) {
      logger.debug(`[SUPERVISOR SCHEDULER] Failed to spawn supervisor: ${e}`);
    }
  }
}
