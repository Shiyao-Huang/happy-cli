/**
 * @module sessionManager
 * @description Daemon session lifecycle: spawn, track, stop, and webhook ingestion.
 *
 * ```mermaid
 * graph TD
 *   A[run.ts] -->|imports| B[sessionManager]
 *   A -->|imports| C[heartbeat]
 *   A -->|imports| D[supervisorScheduler]
 *   B -->|pidToTrackedSession| C
 *   B -->|pidToTrackedSession| D
 *   D -->|spawnSession| B
 * ```
 *
 * ## Exports
 * - `pidToTrackedSession` — central shared Map keyed by OS PID
 * - `onAhaSessionWebhook` — called when a child session reports itself via HTTP
 * - `spawnSession` — spawn a new aha/codex/ralph child process
 * - `stopSession` — SIGTERM a tracked session by sessionId
 * - `stopTeamSessions` — SIGTERM all sessions belonging to a team
 * - `requestHelp` — spawn a help-agent for a specific team
 * - `onChildExited` — remove an exited PID from the tracking map
 */

import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import * as tmp from 'tmp';
import { join } from 'path';

import { TrackedSession } from './types';
import { AgentHeartbeat } from '@/claude/team/heartbeat';
import { Metadata } from '@/api/types';
import { ApiClient } from '@/api/api';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { spawnAhaCLI } from '@/utils/spawnAhaCLI';
import { buildAgentLaunchContext } from '@/utils/agentLaunchContext';
import { emitTraceEvent, emitTraceLink } from '@/trace/traceEmitter';
import { TraceEventKind } from '@/trace/traceTypes';
import { execSync } from 'child_process';
import { ulid } from 'ulid';
import { buildPendingRunId, finalizeRunEnvelopeFromWebhook, resolveCandidateIdentity, writeDraftRunEnvelope } from './runEnvelope';
import { chooseHelpAgentForRequest } from './helpAgentPool';
import { resolveAhaHomeDir } from '@/configurationResolver';
import { seedCodexHomeConfig, seedCodexHomeSkillUnion } from '@/codex/codexHome';

// ── Central shared state ───────────────────────────────────────────────────────
/**
 * Map from OS PID → TrackedSession.
 * Exported so heartbeat.ts and supervisorScheduler.ts can read live session data
 * without duplicating the map reference.
 */
export const pidToTrackedSession = new Map<number, TrackedSession>();
const inFlightHelpRequestsByTeam = new Map<string, Promise<{ success: boolean; helpAgentSessionId?: string; reused?: boolean; saturated?: boolean; error?: string }>>();
const helpAgentLeaseExpiryByTeam = new Map<string, Map<string, number>>();
const HELP_AGENT_POOL_MAX = 2;
const HELP_AGENT_LEASE_MS = 10 * 60 * 1000;

function getHelpAgentLeaseMap(teamId: string): Map<string, number> {
  let leaseMap = helpAgentLeaseExpiryByTeam.get(teamId);
  if (!leaseMap) {
    leaseMap = new Map<string, number>();
    helpAgentLeaseExpiryByTeam.set(teamId, leaseMap);
  }
  return leaseMap;
}

function markHelpAgentLeased(teamId: string, sessionId: string, now = Date.now()): void {
  getHelpAgentLeaseMap(teamId).set(sessionId, now + HELP_AGENT_LEASE_MS);
}

function cleanupHelpAgentLeases(teamId: string, activeSessionIds: string[]): Map<string, number> {
  const leaseMap = getHelpAgentLeaseMap(teamId);
  const activeIds = new Set(activeSessionIds);
  for (const sessionId of [...leaseMap.keys()]) {
    if (!activeIds.has(sessionId)) {
      leaseMap.delete(sessionId);
    }
  }
  return leaseMap;
}

// ── Spawn concurrency limiter ────────────────────────────────────────────────
const MAX_RESPAWN_ATTEMPTS = parseInt(process.env.AHA_MAX_RESPAWN_ATTEMPTS || '3', 10);
const RESPAWN_BASE_DELAY_MS = parseInt(process.env.AHA_RESPAWN_BASE_DELAY_MS || '5000', 10);

interface QueuedSpawn {
  options: SpawnSessionOptions;
}

const spawnQueue: QueuedSpawn[] = [];

function normalizeRespawnAgent(runtimeType?: string): SpawnSessionOptions['agent'] | undefined {
  if (runtimeType === 'codex') return 'codex';
  if (runtimeType === 'ralph') return 'ralph';
  if (runtimeType) return 'claude';
  return undefined;
}

function inferRuntimeTypeFromProcessArgs(commandLine: string): SpawnSessionOptions['agent'] | undefined {
  const runtimeMatch = commandLine.match(/(?:^|\s)(claude|codex|ralph)(?=\s|$)/);
  if (!runtimeMatch) {
    return undefined;
  }
  return normalizeRespawnAgent(runtimeMatch[1]);
}

function resolveProcessWorkingDirectory(pid: number): string | undefined {
  const commands = [
    `lsof -a -d cwd -Fn -p ${pid} 2>/dev/null`,
    `pwdx ${pid} 2>/dev/null`,
    `readlink /proc/${pid}/cwd 2>/dev/null`,
  ];

  for (const command of commands) {
    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (!output) continue;

      if (command.startsWith('lsof')) {
        const pathLine = output.split('\n').find((line) => line.startsWith('n/'));
        if (pathLine) {
          return pathLine.slice(1).trim();
        }
        continue;
      }

      if (command.startsWith('pwdx')) {
        const match = output.match(/^\d+:\s+(.+)$/);
        if (match?.[1]) {
          return match[1].trim();
        }
        continue;
      }

      return output;
    } catch {
      // Try the next strategy.
    }
  }

  return undefined;
}

function buildRespawnableSpawnOptions(params: {
  pid: number;
  teamId?: string;
  memberId?: string;
  role?: string;
  runtimeType?: string;
  displayName?: string;
  sessionTag?: string;
  executionPlane?: string;
  specId?: string;
  parentSessionId?: string;
  customPrompt?: string;
  metadataPath?: string;
  base?: Omit<SpawnSessionOptions, 'onPidKnown' | 'token'>;
}): Omit<SpawnSessionOptions, 'onPidKnown' | 'token'> | undefined {
  const directory = params.metadataPath || params.base?.directory || resolveProcessWorkingDirectory(params.pid);
  if (!directory) {
    return params.base;
  }

  const env: Record<string, string> = {
    ...(params.base?.env || {}),
  };

  if (params.memberId) {
    env.AHA_TEAM_MEMBER_ID = params.memberId;
  }
  if (params.customPrompt) {
    env.AHA_AGENT_PROMPT = params.customPrompt;
  }

  return {
    ...params.base,
    directory,
    agent: normalizeRespawnAgent(params.runtimeType) ?? params.base?.agent,
    sessionTag: params.sessionTag || params.base?.sessionTag,
    teamId: params.teamId || params.base?.teamId,
    role: params.role || params.base?.role,
    sessionName: params.displayName || params.base?.sessionName,
    sessionPath: params.metadataPath || params.base?.sessionPath || directory,
    executionPlane: (params.executionPlane as SpawnSessionOptions['executionPlane'] | undefined) || params.base?.executionPlane,
    specId: params.specId || params.base?.specId,
    parentSessionId: params.parentSessionId || params.base?.parentSessionId,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function isClaudeAgent(session: TrackedSession): boolean {
  if (session.spawnOptions?.agent) {
    return session.spawnOptions.agent !== 'codex' && session.spawnOptions.agent !== 'ralph';
  }
  const flavor = session.ahaSessionMetadataFromLocalWebhook?.flavor;
  return flavor !== 'codex' && flavor !== 'open-code';
}

function getActiveClaudeCount(): number {
  let count = 0;
  for (const session of pidToTrackedSession.values()) {
    if (isClaudeAgent(session)) count++;
  }
  return count;
}

function getMaxConcurrentClaude(): number {
  const raw = process.env.AHA_MAX_CONCURRENT_CLAUDE_AGENTS;
  if (raw == null || raw.trim() === '') {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return parsed;
}

/** Process the next queued spawn if a slot is available. */
function drainSpawnQueue(): void {
  while (spawnQueue.length > 0 && getActiveClaudeCount() < getMaxConcurrentClaude()) {
    const next = spawnQueue.shift()!;
    logger.debug(`[SESSION MANAGER] Dequeuing spawn for role=${next.options.role || 'unknown'} (queue remaining: ${spawnQueue.length})`);
    void spawnSessionInternal(next.options).then((result) => {
      if (result.type === 'error') {
        logger.debug(
          `[SESSION MANAGER] Queued spawn failed for role=${next.options.role || 'unknown'}: ${result.errorMessage}`
        );
      }
    });
  }
}

function reserveQueuedSessionId(existingSessionId?: string): string {
  return existingSessionId || `queued-${ulid().toLowerCase()}`;
}

/**
 * Called by heartbeat when a session is pruned as stale (process no longer exists).
 * Heartbeat already removed the session from pidToTrackedSession and collected the
 * dead session ID — this function handles respawn + queue drain only.
 */
export function onHeartbeatPrunedSession(deadSession: TrackedSession): void {
  // Auto-stash uncommitted changes to prevent code loss
  if (!deadSession.intentionallyStopped) {
    tryAutoStash(deadSession);
  }

  if (isRespawnEligible(deadSession)) {
    scheduleRespawn(deadSession);
  }
  drainSpawnQueue();
}

/**
 * Recover already-running aha sessions after daemon restart.
 * Scans OS processes for `--session-tag team:TEAMID:member:MEMBERID` pattern,
 * re-populates pidToTrackedSession, then resolves real session identity from
 * the team roster via the API.
 *
 * Phase 1: Discover live PIDs and their team/member IDs from process args.
 * Phase 2: For each discovered team, call api.getTeam() to map memberId → real
 *          ahaSessionId + role + executionPlane. Sessions that cannot be resolved
 *          are kept with ahaSessionId=undefined so they don't pollute the live set
 *          but can still be healed by a subsequent webhook.
 */
export async function recoverExistingSessions(api?: ApiClient): Promise<number> {
  let recovered = 0;
  try {
    // ── Phase 1: Discover PIDs ──────────────────────────────────────────────
    const psOutput = execSync('ps -eo pid,args 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    const tagPattern = /^\s*(\d+)\s+.*--session-tag\s+team:([^\s:]+):member:([^\s:]+)(?:\s|$)/;

    // Collect discovered processes grouped by teamId
    const discovered: Array<{
      pid: number;
      teamId: string;
      memberId: string;
      runtimeType?: SpawnSessionOptions['agent'];
    }> = [];

    for (const line of psOutput.split('\n')) {
      const match = line.match(tagPattern);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const teamId = match[2];
      const memberId = match[3];

      // Skip if already tracked or if it's our own daemon process
      if (pidToTrackedSession.has(pid) || pid === process.pid) continue;

      // Verify process is still alive
      try {
        process.kill(pid, 0);
      } catch {
        continue; // Process already dead
      }

      discovered.push({
        pid,
        teamId,
        memberId,
        runtimeType: inferRuntimeTypeFromProcessArgs(line),
      });
    }

    if (discovered.length === 0) return 0;

    // ── Phase 2: Resolve identity from team roster ──────────────────────────
    // Group by teamId so we make one API call per team
    const byTeam = new Map<string, typeof discovered>();
    for (const entry of discovered) {
      const list = byTeam.get(entry.teamId) ?? [];
      list.push(entry);
      byTeam.set(entry.teamId, list);
    }

    for (const [teamId, entries] of Array.from(byTeam.entries())) {
      // Try to fetch team roster for identity resolution
      let teamMembers: Array<{
        memberId?: string;
        sessionId?: string;
        roleId?: string;
        executionPlane?: string;
        runtimeType?: string;
        displayName?: string;
        sessionTag?: string;
        specId?: string;
        parentSessionId?: string;
        customPrompt?: string;
      }> = [];

      if (api) {
        try {
          const teamData = await api.getTeam(teamId);
          teamMembers = teamData?.team?.members ?? [];
        } catch (error) {
          logger.debug(
            `[SESSION MANAGER] Failed to fetch team roster for ${teamId} during recovery: ` +
            `${error instanceof Error ? error.message : 'unknown'}`
          );
        }
      }

      const rosterFetchedSuccessfully = teamMembers.length > 0 || api != null;

      for (const { pid, memberId, runtimeType } of entries) {
        // Try to find this member in the team roster
        const rosterMember = teamMembers.find(m => m.memberId === memberId);
        const resolvedRuntimeType = rosterMember?.runtimeType || runtimeType;

        // Defense-in-depth: if the server marks this member as archived or
        // archiveRequested, kill the orphaned process and skip recovery.
        // This catches sessions that were archived without being killed (e.g.
        // archive_session called without kill_agent prior to this fix).
        const rosterLifecycle = (rosterMember as any)?.lifecycleState as string | undefined;
        if (rosterLifecycle === 'archived' || rosterLifecycle === 'archiveRequested') {
          logger.debug(
            `[SESSION MANAGER] Skipping recovery of PID ${pid} (member: ${memberId}) — ` +
            `lifecycleState=${rosterLifecycle}; terminating orphaned process`
          );
          try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
          continue;
        }

        // If we successfully fetched the roster but this member is not in it,
        // it was removed (e.g. by replace_agent or kill_agent) — treat as orphan.
        if (!rosterMember && rosterFetchedSuccessfully && teamMembers.length > 0) {
          logger.debug(
            `[SESSION MANAGER] Skipping recovery of PID ${pid} (member: ${memberId}) — ` +
            `not found in team roster; terminating orphaned process`
          );
          try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
          continue;
        }

        const trackedSession: TrackedSession = {
          startedBy: 'recovered after daemon restart',
          pid,
        };

        trackedSession.spawnOptions = buildRespawnableSpawnOptions({
          pid,
          teamId,
          memberId,
          role: rosterMember?.roleId,
          runtimeType: resolvedRuntimeType,
          displayName: rosterMember?.displayName,
          sessionTag: rosterMember?.sessionTag,
          executionPlane: rosterMember?.executionPlane,
          specId: rosterMember?.specId,
          parentSessionId: rosterMember?.parentSessionId,
          customPrompt: rosterMember?.customPrompt,
        });

        if (rosterMember?.sessionId) {
          // Successfully resolved — use real session identity
          trackedSession.ahaSessionId = rosterMember.sessionId;
          trackedSession.ahaSessionMetadataFromLocalWebhook = {
            teamId,
            roomId: teamId,
            hostPid: pid,
            role: rosterMember.roleId,
            executionPlane: rosterMember.executionPlane as 'mainline' | 'bypass' | undefined,
            flavor: resolvedRuntimeType,
            memberId,
            sessionTag: rosterMember.sessionTag,
            name: rosterMember.displayName,
          } as Metadata;
          logger.debug(
            `[SESSION MANAGER] Recovered session ${rosterMember.sessionId} ` +
            `(team: ${teamId}, member: ${memberId}, role: ${rosterMember.roleId || 'unknown'}, PID: ${pid})`
          );
        } else {
          // Could not resolve — leave ahaSessionId undefined so this session
          // does not pollute collectLiveMainlineSessionIdsByTeam, but keep
          // it in pidToTrackedSession so a subsequent webhook can heal it.
          trackedSession.ahaSessionId = undefined;
          trackedSession.ahaSessionMetadataFromLocalWebhook = {
            teamId,
            roomId: teamId,
            hostPid: pid,
            flavor: resolvedRuntimeType,
            memberId,
          } as Metadata;
          logger.debug(
            `[SESSION MANAGER] Partially recovered PID ${pid} (team: ${teamId}, member: ${memberId}) ` +
            `— could not resolve true ahaSessionId from team roster, awaiting webhook self-heal`
          );
        }

        pidToTrackedSession.set(pid, trackedSession);
        recovered++;
      }
    }

    if (recovered > 0) {
      const resolved = [...pidToTrackedSession.values()].filter(
        s => s.startedBy === 'recovered after daemon restart' && s.ahaSessionId
      ).length;
      const unresolved = recovered - resolved;
      logger.debug(
        `[SESSION MANAGER] Recovered ${recovered} sessions after daemon restart ` +
        `(${resolved} resolved, ${unresolved} unresolved)`
      );
    }
  } catch (error) {
    logger.debug(`[SESSION MANAGER] Session recovery scan failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  return recovered;
}

function looksLikeConcatenatedAbsolutePaths(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  const absolutePathTokens = trimmed.match(/(?:^|[\s\n])\/[^\s]+/g) ?? [];
  return absolutePathTokens.length > 1;
}

// ── Internal awaiter system ────────────────────────────────────────────────────
// Resolvers keyed by PID, awaiting the session-started webhook to populate ahaSessionId.
const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

// ── Heartbeat dependency ───────────────────────────────────────────────────────
// teamHeartbeats is managed in run.ts and injected here via the ping callback.
// We keep a module-level reference so webhook and spawn paths can ping without
// passing the callback through every call site.
let _pingHeartbeat: ((session: TrackedSession) => void) | null = null;

/**
 * Wire up the heartbeat ping function from run.ts.
 * Called once during daemon startup, before any sessions are spawned.
 */
export function initSessionManagerHeartbeat(pingFn: (session: TrackedSession) => void): void {
  _pingHeartbeat = pingFn;
}

function pingHeartbeatIfAvailable(session: TrackedSession): void {
  _pingHeartbeat?.(session);
}

// ── Dead session callback ────────────────────────────────────────────────────
// Injected from run.ts so onChildExited can report dead sessions immediately
// rather than waiting for the next heartbeat cycle.
let _onSessionDead: ((sessionIds: string[]) => void) | null = null;

/**
 * Wire up the dead session reporting callback from run.ts.
 * Called once during daemon startup.
 */
export function initSessionManagerDeadCallback(fn: (sessionIds: string[]) => void): void {
  _onSessionDead = fn;
}

export function resetSessionManagerForTests(): void {
  pidToTrackedSession.clear();
  inFlightHelpRequestsByTeam.clear();
  spawnQueue.length = 0;
  pidToAwaiter.clear();
  _pingHeartbeat = null;
  _onSessionDead = null;
}

// ── Webhook handler ────────────────────────────────────────────────────────────

/**
 * Called when a child aha session POSTs to the daemon's /session-started endpoint.
 * Updates the tracked session with its assigned sessionId and metadata.
 */
export const onAhaSessionWebhook = (sessionId: string, sessionMetadata: Metadata): void => {
  logger.debugLargeJson(`[SESSION MANAGER] Session reported`, sessionMetadata);

  const pid = sessionMetadata.hostPid;
  if (!pid) {
    logger.debug(`[SESSION MANAGER] Session webhook missing hostPid for sessionId: ${sessionId}`);
    return;
  }

  logger.debug(`[SESSION MANAGER] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
  logger.debug(`[SESSION MANAGER] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

  const existingSession = pidToTrackedSession.get(pid);

  if (existingSession && existingSession.startedBy === 'daemon') {
    // Update daemon-spawned session with reported data
    existingSession.ahaSessionId = sessionId;
    existingSession.ahaSessionMetadataFromLocalWebhook = sessionMetadata;
    existingSession.spawnOptions = buildRespawnableSpawnOptions({
      pid,
      teamId: sessionMetadata.teamId || sessionMetadata.roomId,
      memberId: sessionMetadata.memberId,
      role: sessionMetadata.role,
      runtimeType: sessionMetadata.flavor,
      displayName: sessionMetadata.name,
      sessionTag: sessionMetadata.sessionTag,
      executionPlane: sessionMetadata.executionPlane,
      metadataPath: sessionMetadata.path,
      base: existingSession.spawnOptions,
    });
    logger.debug(`[SESSION MANAGER] Updated daemon-spawned session ${sessionId} with metadata`);
    void finalizeRunEnvelopeFromWebhook({
      pid,
      sessionId,
      metadata: sessionMetadata,
      spawnOptions: existingSession.spawnOptions,
    }).catch((error) => {
      logger.debug(`[SESSION MANAGER] Failed to finalize run envelope for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    pingHeartbeatIfAvailable(existingSession);

    // Trace: session_registered
    try {
      emitTraceEvent(
        TraceEventKind.session_registered,
        'daemon',
        {
          team_id: sessionMetadata.teamId || sessionMetadata.roomId,
          session_id: sessionId,
          pid,
        },
        `Session ${sessionId} registered via webhook (PID=${pid}, role=${sessionMetadata.role || 'unknown'})`,
        { attrs: { role: sessionMetadata.role, startedBy: sessionMetadata.startedBy } },
      );
    } catch { /* trace must never break main flow */ }

    // Resolve any awaiter for this PID
    const awaiter = pidToAwaiter.get(pid);
    if (awaiter) {
      pidToAwaiter.delete(pid);
      awaiter(existingSession);
      logger.debug(`[SESSION MANAGER] Resolved session awaiter for PID ${pid}`);
    }
  } else if (existingSession && existingSession.startedBy === 'recovered after daemon restart') {
    // Self-heal recovered session with real webhook metadata
    const previousId = existingSession.ahaSessionId;
    existingSession.ahaSessionId = sessionId;
    existingSession.ahaSessionMetadataFromLocalWebhook = sessionMetadata;
    existingSession.spawnOptions = buildRespawnableSpawnOptions({
      pid,
      teamId: sessionMetadata.teamId || sessionMetadata.roomId,
      memberId: sessionMetadata.memberId,
      role: sessionMetadata.role,
      runtimeType: sessionMetadata.flavor,
      displayName: sessionMetadata.name,
      sessionTag: sessionMetadata.sessionTag,
      executionPlane: sessionMetadata.executionPlane,
      metadataPath: sessionMetadata.path,
      base: existingSession.spawnOptions,
    });
    existingSession.startedBy = 'daemon'; // Normalize so future webhooks follow the standard path
    logger.debug(
      `[SESSION MANAGER] Self-healed recovered session: ${previousId || '(unresolved)'} → ${sessionId} ` +
      `(PID: ${pid}, role: ${sessionMetadata.role || 'unknown'})`
    );
    void finalizeRunEnvelopeFromWebhook({
      pid,
      sessionId,
      metadata: sessionMetadata,
      spawnOptions: existingSession.spawnOptions,
    }).catch((error) => {
      logger.debug(`[SESSION MANAGER] Failed to finalize recovered run envelope for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    pingHeartbeatIfAvailable(existingSession);
  } else if (!existingSession) {
    // New session started externally (user ran aha directly)
    const trackedSession: TrackedSession = {
      startedBy: 'aha directly - likely by user from terminal',
      ahaSessionId: sessionId,
      ahaSessionMetadataFromLocalWebhook: sessionMetadata,
      pid,
    };
    pidToTrackedSession.set(pid, trackedSession);
    void finalizeRunEnvelopeFromWebhook({
      pid,
      sessionId,
      metadata: sessionMetadata,
      spawnOptions: trackedSession.spawnOptions,
    }).catch((error) => {
      logger.debug(`[SESSION MANAGER] Failed to create external run envelope for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    logger.debug(`[SESSION MANAGER] Registered externally-started session ${sessionId}`);
    pingHeartbeatIfAvailable(trackedSession);
  }
};

// ── Session spawning ───────────────────────────────────────────────────────────

/**
 * Public entry point: spawn a new agent session with concurrency control.
 * Claude agents are limited to MAX_CONCURRENT_CLAUDE concurrent sessions.
 * Excess spawns are queued and drained as slots free up.
 */
export const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
  const isClaude = options.agent !== 'codex' && options.agent !== 'ralph';
  const activeClaudeCount = getActiveClaudeCount();
  const maxConcurrentClaude = getMaxConcurrentClaude();

  if (isClaude && Number.isFinite(maxConcurrentClaude) && activeClaudeCount >= maxConcurrentClaude) {
    const reservedSessionId = reserveQueuedSessionId(options.sessionId);
    const queuedOptions = {
      ...options,
      sessionId: reservedSessionId,
    };
    const queuePosition = spawnQueue.length + 1;
    logger.debug(
      `[SESSION MANAGER] Claude concurrency limit reached (${activeClaudeCount}/${maxConcurrentClaude}). ` +
      `Queuing spawn for role=${options.role || 'unknown'} as ${reservedSessionId} (queue depth: ${queuePosition})`
    );
    spawnQueue.push({ options: queuedOptions });
    return {
      type: 'queued',
      sessionId: reservedSessionId,
      queuePosition,
    };
  }

  return spawnSessionInternal(options);
};

/**
 * Internal spawn: creates the child process and tracks it.
 * Awaits the session-started webhook for up to 15 seconds before timing out.
 */
const spawnSessionInternal = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
  logger.debugLargeJson('[SESSION MANAGER] Spawning session', options);

  // Trace: spawn_started
  let spawnStartedEventId: string | null = null;
  try {
    spawnStartedEventId = emitTraceEvent(
      TraceEventKind.spawn_started,
      'daemon',
      {
        team_id: options.teamId,
        session_id: options.sessionId,
      },
      `Daemon dispatching spawn for role=${options.role || 'unknown'} runtime=${options.agent || 'claude'} dir=${options.directory}`,
      { attrs: { role: options.role, runtime: options.agent || 'claude', directory: options.directory } },
    );
  } catch { /* trace must never break main flow */ }

  const { directory, sessionId, approvedNewDirectoryCreation = true } = options;
  let directoryCreated = false;

  if (looksLikeConcatenatedAbsolutePaths(directory)) {
    const errorMessage = `Invalid working directory: "${directory}". It appears to contain multiple absolute paths joined together. Provide exactly one project directory.`;
    logger.debug(`[SESSION MANAGER] ${errorMessage}`);
    return {
      type: 'error',
      errorMessage,
    };
  }

  if (options.sessionPath && looksLikeConcatenatedAbsolutePaths(options.sessionPath)) {
    const errorMessage = `Invalid sessionPath: "${options.sessionPath}". It appears to contain multiple absolute paths joined together. Provide exactly one project directory.`;
    logger.debug(`[SESSION MANAGER] ${errorMessage}`);
    return {
      type: 'error',
      errorMessage,
    };
  }

  try {
    await fs.access(directory);
    logger.debug(`[SESSION MANAGER] Directory exists: ${directory}`);
  } catch {
    logger.debug(`[SESSION MANAGER] Directory doesn't exist, creating: ${directory}`);

    if (!approvedNewDirectoryCreation) {
      logger.debug(`[SESSION MANAGER] Directory creation not approved for: ${directory}`);
      return {
        type: 'requestToApproveDirectoryCreation',
        directory,
      };
    }

    try {
      await fs.mkdir(directory, { recursive: true });
      logger.debug(`[SESSION MANAGER] Successfully created directory: ${directory}`);
      directoryCreated = true;
    } catch (mkdirError: unknown) {
      const err = mkdirError as NodeJS.ErrnoException;
      let errorMessage = `Unable to create directory at '${directory}'. `;

      if (err.code === 'EACCES') {
        errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
      } else if (err.code === 'ENOTDIR') {
        errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
      } else if (err.code === 'ENOSPC') {
        errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
      } else if (err.code === 'EROFS') {
        errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
      } else {
        errorMessage += `System error: ${err.message || err}. Please verify the path is valid and you have the necessary permissions.`;
      }

      logger.debug(`[SESSION MANAGER] Directory creation failed: ${errorMessage}`);
      return {
        type: 'error',
        errorMessage,
      };
    }
  }

  try {
    let extraEnv: Record<string, string> = {};

    if (options.agent === 'codex') {
      const codexHomeDir = tmp.dirSync({ unsafeCleanup: true });
      seedCodexHomeConfig(codexHomeDir.name, { token: options.token });
      seedCodexHomeSkillUnion(codexHomeDir.name, {
        commandsDir: options.env?.AHA_AGENT_COMMANDS_DIR,
      });
      logger.debug(`[SESSION MANAGER] Prepared isolated Codex home at ${codexHomeDir.name}`);
      extraEnv = { CODEX_HOME: codexHomeDir.name };
    } else if (options.token) {
      extraEnv = { CLAUDE_CODE_OAUTH_TOKEN: options.token };
    }

    if (options.teamId) {
      extraEnv.AHA_ROOM_ID = options.teamId;
      logger.debug(`[SESSION MANAGER] Setting AHA_ROOM_ID=${options.teamId}`);
    }
    if (options.role) {
      extraEnv.AHA_AGENT_ROLE = options.role;
      logger.debug(`[SESSION MANAGER] Setting AHA_AGENT_ROLE=${options.role}`);
    }
    if (options.sessionName) {
      extraEnv.AHA_SESSION_NAME = options.sessionName;
      logger.debug(`[SESSION MANAGER] Setting AHA_SESSION_NAME=${options.sessionName}`);
    }
    if (options.sessionPath) {
      extraEnv.AHA_SESSION_PATH = options.sessionPath;
      logger.debug(`[SESSION MANAGER] Setting AHA_SESSION_PATH=${options.sessionPath}`);
    }
    if (options.parentSessionId) {
      extraEnv.AHA_PARENT_SESSION_ID = options.parentSessionId;
      logger.debug(`[SESSION MANAGER] Setting AHA_PARENT_SESSION_ID=${options.parentSessionId}`);
    }
    const candidateIdentity = resolveCandidateIdentity({
      specId: options.specId ?? null,
      role: options.role,
      runtimeType: options.agent,
      executionPlane: options.executionPlane,
      prompt: options.env?.AHA_AGENT_PROMPT,
      materializedSettingsPath: options.env?.AHA_SETTINGS_PATH ?? null,
    });
    if (candidateIdentity.specId) {
      extraEnv.AHA_SPEC_ID = candidateIdentity.specId;
      logger.debug(`[SESSION MANAGER] Setting AHA_SPEC_ID=${candidateIdentity.specId}`);
    }
    extraEnv.AHA_CANDIDATE_ID = candidateIdentity.candidateId;
    extraEnv.AHA_CANDIDATE_IDENTITY_JSON = JSON.stringify(candidateIdentity);
    logger.debug(`[SESSION MANAGER] Setting AHA_CANDIDATE_ID=${extraEnv.AHA_CANDIDATE_ID}`);
    if (options.executionPlane) {
      extraEnv.AHA_EXECUTION_PLANE = options.executionPlane;
      logger.debug(`[SESSION MANAGER] Setting AHA_EXECUTION_PLANE=${options.executionPlane}`);
    }
    if (sessionId) {
      extraEnv.AHA_RECOVER_SESSION_ID = sessionId;
      logger.debug(`[SESSION MANAGER] Setting AHA_RECOVER_SESSION_ID=${sessionId}`);
    }
    if (options.env) {
      Object.assign(extraEnv, options.env);
      logger.debug(`[SESSION MANAGER] Merging custom env: ${JSON.stringify(options.env)}`);
    }

    const launchContext = buildAgentLaunchContext({
      directory,
      existingPrompt: extraEnv.AHA_AGENT_PROMPT,
      includeTeamHelpLane: Boolean(options.teamId),
      includeProjectInstructions: options.agent !== 'codex',
      predecessorHandoff: extraEnv.AHA_PREDECESSOR_HANDOFF,
      predecessorSessionId: options.parentSessionId,
    });
    extraEnv.AHA_AGENT_PROMPT = launchContext.prompt;
    if (!extraEnv.AHA_AGENT_SCOPE_SUMMARY && launchContext.scopeSummary) {
      extraEnv.AHA_AGENT_SCOPE_SUMMARY = launchContext.scopeSummary;
    }
    logger.debug(`[SESSION MANAGER] Injected launch boundary context for ${options.role || 'agent'}: ${extraEnv.AHA_AGENT_SCOPE_SUMMARY || launchContext.scopeSummary || 'no explicit scope summary'}`);

    let args: string[];
    if (options.agent === 'ralph') {
      args = [
        'ralph', 'start',
        '--prd', options.prdPath || join(directory, 'prd.json'),
        '--max-iterations', String(options.maxIterations || 10),
        '--started-by', 'daemon',
      ];
    } else {
      args = [
        options.agent === 'codex' ? 'codex' : 'claude',
        '--aha-starting-mode', 'remote',
        '--started-by', 'daemon',
      ];
    }

    if (options.sessionTag) {
      args.push('--session-tag', options.sessionTag);
    }

    const { CLAUDECODE: _, ...cleanEnv } = process.env;
    const ahaProcess = spawnAhaCLI(args, {
      cwd: directory,
      detached: true,
      // Daemon-spawned agents write their own file logs. Do not bind child stdout/stderr
      // to daemon-owned pipes or the child will die with EPIPE when the daemon restarts.
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...cleanEnv,
        ...extraEnv,
      },
    });

    if (process.env.DEBUG) {
      ahaProcess.stdout?.on('data', (data) => {
        logger.debug(`[SESSION MANAGER] Child stdout: ${data.toString()}`);
      });
      ahaProcess.stderr?.on('data', (data) => {
        logger.debug(`[SESSION MANAGER] Child stderr: ${data.toString()}`);
      });
    }

    if (!ahaProcess.pid) {
      logger.debug('[SESSION MANAGER] Failed to spawn process - no PID returned');
      return {
        type: 'error',
        errorMessage: 'Failed to spawn Aha process - no PID returned',
      };
    }

    logger.debug(`[SESSION MANAGER] Spawned process with PID ${ahaProcess.pid}`);

    // Trace: process_started
    let processStartedEventId: string | null = null;
    try {
      processStartedEventId = emitTraceEvent(
        TraceEventKind.process_started,
        'daemon',
        {
          team_id: options.teamId,
          session_id: options.sessionId,
          pid: ahaProcess.pid,
        },
        `Process started PID=${ahaProcess.pid} role=${options.role || 'unknown'}`,
        { attrs: { role: options.role, runtime: options.agent || 'claude' } },
      );
      if (processStartedEventId && spawnStartedEventId) {
        emitTraceLink(processStartedEventId, spawnStartedEventId, 'caused_by');
      }
    } catch { /* trace must never break main flow */ }

    // Notify caller immediately with the PID (before webhook arrives)
    options.onPidKnown?.(ahaProcess.pid);

    // Store spawn options (without sensitive fields) for potential respawn
    const { onPidKnown: _opk, token: _tok, ...respawnableOptions } = options;

    const trackedSession: TrackedSession = {
      startedBy: 'daemon',
      pid: ahaProcess.pid,
      childProcess: ahaProcess,
      directoryCreated,
      message: directoryCreated
        ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.`
        : undefined,
      spawnOptions: respawnableOptions,
      respawnCount: parseInt(options.env?.AHA_RESPAWN_COUNT || '0', 10),
    };

    pidToTrackedSession.set(ahaProcess.pid, trackedSession);
    void writeDraftRunEnvelope({
      pid: ahaProcess.pid,
      options: respawnableOptions,
    }).catch((error) => {
      logger.debug(`[SESSION MANAGER] Failed to write draft run envelope for PID ${ahaProcess.pid}: ${error instanceof Error ? error.message : String(error)}`);
    });

    ahaProcess.on('exit', (code, signal) => {
      logger.debug(`[SESSION MANAGER] Child PID ${ahaProcess.pid} exited with code ${code}, signal ${signal}`);
      if (ahaProcess.pid) {
        onChildExited(ahaProcess.pid);
      }
    });

    ahaProcess.on('error', (error) => {
      logger.debug(`[SESSION MANAGER] Child process error:`, error);
      if (ahaProcess.pid) {
        onChildExited(ahaProcess.pid);
      }
    });

    logger.debug(`[SESSION MANAGER] Waiting for session webhook for PID ${ahaProcess.pid}`);

    return new Promise((resolve) => {
      const sessionWebhookTimeoutMs = parseInt(
        process.env.AHA_SESSION_WEBHOOK_TIMEOUT_MS || '15000',
        10
      );

      const timeout = setTimeout(() => {
        pidToAwaiter.delete(ahaProcess.pid!);
        logger.debug(`[SESSION MANAGER] Session webhook timeout for PID ${ahaProcess.pid}`);
        resolve({
          type: 'pending',
          pendingSessionId: buildPendingRunId(ahaProcess.pid!, options.sessionId),
          pid: ahaProcess.pid!,
        });
      }, sessionWebhookTimeoutMs);

      pidToAwaiter.set(ahaProcess.pid!, (completedSession) => {
        clearTimeout(timeout);
        logger.debug(`[SESSION MANAGER] Session ${completedSession.ahaSessionId} fully spawned with webhook`);
        resolve({
          type: 'success',
          sessionId: completedSession.ahaSessionId!,
        });
      });
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.debug('[SESSION MANAGER] Failed to spawn session:', error);
    return {
      type: 'error',
      errorMessage: `Failed to spawn session: ${errorMessage}`,
    };
  }
};

// ── Session termination ────────────────────────────────────────────────────────

const SIGKILL_ESCALATION_MS = 5000;

/**
 * Stop a session by its ahaSessionId (or PID-<n> fallback).
 * Sends SIGTERM first, then escalates to SIGKILL after a timeout.
 * Returns true if found and killed, false if not found.
 */
export const stopSession = (sessionId: string): boolean => {
  logger.debug(`[SESSION MANAGER] Attempting to stop session ${sessionId}`);

  for (const [pid, session] of pidToTrackedSession.entries()) {
    if (
      session.ahaSessionId === sessionId ||
      (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))
    ) {
      // Mark as intentionally stopped to prevent auto-respawn
      session.intentionallyStopped = true;


      const sendSignal = (signal: NodeJS.Signals) => {
        if (session.startedBy === 'daemon' && session.childProcess) {
          try {
            session.childProcess.kill(signal);
            logger.debug(`[SESSION MANAGER] Sent ${signal} to daemon-spawned session ${sessionId}`);
          } catch (error) {
            logger.debug(`[SESSION MANAGER] Failed to send ${signal} to session ${sessionId}:`, error);
          }
        } else {
          try {
            process.kill(pid, signal);
            logger.debug(`[SESSION MANAGER] Sent ${signal} to external session PID ${pid}`);
          } catch (error) {
            logger.debug(`[SESSION MANAGER] Failed to send ${signal} to PID ${pid}:`, error);
          }
        }
      };

      sendSignal('SIGTERM');

      // Escalate to SIGKILL if process is still alive after timeout
      setTimeout(() => {
        try {
          process.kill(pid, 0); // Check if process is still alive
          logger.debug(`[SESSION MANAGER] Session ${sessionId} (PID ${pid}) still alive after SIGTERM, sending SIGKILL`);
          sendSignal('SIGKILL');
        } catch {
          // Process already exited — no escalation needed
        }
      }, SIGKILL_ESCALATION_MS);

      // Snapshot and report death BEFORE deleting tracking, so the backend
      // learns about the kill immediately. onChildExited will no-op since
      // the tracking entry is already gone by the time the 'exit' event fires.
      if (session.ahaSessionId && _onSessionDead) {
        _onSessionDead([session.ahaSessionId]);
      }
      pidToTrackedSession.delete(pid);
      logger.debug(`[SESSION MANAGER] Removed session ${sessionId} from tracking`);
      return true;
    }
  }

  logger.debug(`[SESSION MANAGER] Session ${sessionId} not found`);
  return false;
};

/**
 * Stop all sessions belonging to a team.
 * Returns the count of stopped sessions and any error messages.
 */
export const stopTeamSessions = (teamId: string): { stopped: number; errors: string[] } => {
  logger.debug(`[SESSION MANAGER] Attempting to stop all sessions for team ${teamId}`);

  const errors: string[] = [];
  let stopped = 0;

  const deadSessionIds: string[] = [];

  for (const [pid, session] of pidToTrackedSession.entries()) {
    const metadata = session.ahaSessionMetadataFromLocalWebhook;
    const sessionTeamId = metadata?.teamId || metadata?.roomId;

    if (sessionTeamId === teamId) {
      const sessionId = session.ahaSessionId || `PID-${pid}`;
      logger.debug(`[SESSION MANAGER] Stopping team session ${sessionId} (PID: ${pid})`);

      // Mark as intentionally stopped to prevent auto-respawn
      session.intentionallyStopped = true;

      try {
        if (session.startedBy === 'daemon' && session.childProcess) {
          session.childProcess.kill('SIGTERM');
        } else {
          process.kill(pid, 'SIGTERM');
        }
        if (session.ahaSessionId) {
          deadSessionIds.push(session.ahaSessionId);
        }
        pidToTrackedSession.delete(pid);
        stopped++;
        logger.debug(`[SESSION MANAGER] Stopped team session ${sessionId}`);
      } catch (error) {
        const errorMsg = `Failed to stop session ${sessionId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        logger.debug(`[SESSION MANAGER] ${errorMsg}`);
        errors.push(errorMsg);
      }
    }
  }

  if (deadSessionIds.length > 0 && _onSessionDead) {
    _onSessionDead(deadSessionIds);
  }

  logger.debug(`[SESSION MANAGER] Stopped ${stopped} sessions for team ${teamId}, errors: ${errors.length}`);
  return { stopped, errors };
};

// ── Help agent ─────────────────────────────────────────────────────────────────

/**
 * Spawn a help-agent session for a team.
 * Picks a non-supervisor/non-help-agent session from the team as the target if none is provided.
 */
export const requestHelp = async (params: {
  teamId: string;
  sessionId?: string;
  type: string;
  description: string;
  severity: string;
}): Promise<{ success: boolean; helpAgentSessionId?: string; reused?: boolean; saturated?: boolean; error?: string }> => {
  const { teamId, type, description, severity } = params;

  const inFlight = inFlightHelpRequestsByTeam.get(teamId);
  if (inFlight) {
    logger.debug(`[SESSION MANAGER] Reusing in-flight help-agent spawn for team ${teamId}`);
    return await inFlight;
  }

  const requestPromise = (async () => {
    const activeHelpAgents = Array.from(pidToTrackedSession.values())
      .filter((session) => {
        const metadata = session.ahaSessionMetadataFromLocalWebhook;
        const sessionTeamId = metadata?.teamId || metadata?.roomId;
        return sessionTeamId === teamId && metadata?.role === 'help-agent' && !!session.ahaSessionId;
      })
      .sort((a, b) => b.pid - a.pid);

    const activeHelpAgentSessionIds = activeHelpAgents
      .map((session) => session.ahaSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId));
    const leaseMap = cleanupHelpAgentLeases(teamId, activeHelpAgentSessionIds);
    const poolDecision = chooseHelpAgentForRequest({
      activeSessionIds: activeHelpAgentSessionIds,
      leaseExpiryBySessionId: leaseMap,
      maxAgents: HELP_AGENT_POOL_MAX,
    });

    if (poolDecision.action === 'reuse' && poolDecision.sessionId) {
      const reusableSessionId = poolDecision.sessionId;
      markHelpAgentLeased(teamId, reusableSessionId);
      logger.debug(
        `[SESSION MANAGER] Reusing existing help-agent ${reusableSessionId} for team ${teamId}; ` +
        `${poolDecision.saturated ? 'pool saturated, queueing onto existing agent' : 'preferring idle instance'}`
      );
      return {
        success: true,
        helpAgentSessionId: reusableSessionId,
        reused: true,
        saturated: poolDecision.saturated ?? false,
      };
    }

    let targetSessionId = params.sessionId;
    if (!targetSessionId) {
      for (const session of pidToTrackedSession.values()) {
        const metadata = session.ahaSessionMetadataFromLocalWebhook;
        const sessionTeamId = metadata?.teamId || metadata?.roomId;
        const role = metadata?.role;
        if (sessionTeamId !== teamId) continue;
        if (role === 'supervisor' || role === 'help-agent') continue;
        if (session.ahaSessionId) {
          targetSessionId = session.ahaSessionId;
          break;
        }
      }
    }

    if (!targetSessionId) {
      return { success: false, error: `No recoverable team session found for team ${teamId}` };
    }

    try {
      const result = await spawnSession({
        directory: process.cwd(),
        agent: 'claude',
        teamId,
        role: 'help-agent',
        sessionName: 'Help Agent',
        executionPlane: 'bypass',
        env: {
          AHA_HELP_TARGET_SESSION: targetSessionId,
          AHA_HELP_TYPE: type,
          AHA_HELP_DESCRIPTION: description,
          AHA_HELP_SEVERITY: severity,
        },
      });

      if (result.type === 'success' || result.type === 'queued') {
        markHelpAgentLeased(teamId, result.sessionId);
        return { success: true, helpAgentSessionId: result.sessionId, reused: false, saturated: false };
      }
      if (result.type === 'pending') {
        return {
          success: false,
          error: `Help-agent launch is pending webhook binding (${result.pendingSessionId})`,
        };
      }

      return {
        success: false,
        error: result.type === 'error' ? result.errorMessage : 'Failed to spawn help-agent',
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  })();

  inFlightHelpRequestsByTeam.set(teamId, requestPromise);
  try {
    return await requestPromise;
  } finally {
    if (inFlightHelpRequestsByTeam.get(teamId) === requestPromise) {
      inFlightHelpRequestsByTeam.delete(teamId);
    }
  }
};

// ── Auto-stash on agent death ────────────────────────────────────────────────

/**
 * Attempt to git stash uncommitted changes in an agent's working directory.
 * Called when a daemon-spawned agent exits unexpectedly (not intentionally stopped).
 * This prevents code loss when agents die mid-work.
 *
 * Runs asynchronously — never blocks the main exit handler.
 */
function tryAutoStash(session: TrackedSession): void {
  const directory = session.spawnOptions?.directory;
  if (!directory) return;
  if (session.intentionallyStopped) return;

  const role = session.spawnOptions?.role || 'unknown';
  const sessionId = session.ahaSessionId || 'unknown';

  try {
    // Quick check: does the directory have a .git folder?
    const gitCheck = execSync('git rev-parse --is-inside-work-tree 2>/dev/null', {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (gitCheck !== 'true') return;

    // Check for uncommitted changes
    const status = execSync('git status --porcelain 2>/dev/null', {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!status) {
      logger.debug(`[SESSION MANAGER] No uncommitted changes in ${directory} for ${role} (${sessionId})`);
      return;
    }

    const changedFiles = status.split('\n').length;
    logger.debug(
      `[SESSION MANAGER] Auto-stashing ${changedFiles} uncommitted changes in ${directory} ` +
      `for crashed agent ${role} (${sessionId})`
    );

    // Stage all changes and stash with descriptive message
    const stashMessage = `auto-stash: agent ${role} (${sessionId}) crashed at ${new Date().toISOString()}`;
    execSync(`git add -A && git stash push -m "${stashMessage}" 2>/dev/null`, {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 10000,
    });

    logger.debug(`[SESSION MANAGER] Auto-stash successful: "${stashMessage}"`);
  } catch (error) {
    logger.debug(
      `[SESSION MANAGER] Auto-stash failed for ${directory}: ` +
      `${error instanceof Error ? error.message : 'unknown'}`
    );
  }
}

// ── Child exit handler ─────────────────────────────────────────────────────────

/**
 * Determine if an exited session is eligible for automatic respawn.
 *
 * Eligible sessions must:
 * - Have stored spawnOptions (daemon-spawned with known config)
 * - Not have been intentionally stopped
 * - Be a mainline agent (not supervisor, help-agent, or bypass plane)
 * - Be under the max respawn attempt limit
 */
function isRespawnEligible(session: TrackedSession): boolean {
  if (!session.spawnOptions) return false;
  if (session.intentionallyStopped) return false;
  if (session.startedBy !== 'daemon') return false;

  const role = session.spawnOptions.role || session.ahaSessionMetadataFromLocalWebhook?.role;
  if (role === 'supervisor' || role === 'help-agent') return false;

  const plane = session.spawnOptions.executionPlane || session.ahaSessionMetadataFromLocalWebhook?.executionPlane;
  if (plane === 'bypass') return false;

  const respawnCount = session.respawnCount ?? 0;
  if (respawnCount >= MAX_RESPAWN_ATTEMPTS) return false;

  return true;
}

/**
 * Try to read a handoff note left by a predecessor session.
 * Returns the file contents if found, null otherwise (best-effort, never throws).
 */
function tryReadPredecessorHandoff(predecessorSessionId: string): string | null {
  if (!predecessorSessionId) return null;
  try {
    const handoffPath = join(resolveAhaHomeDir(), 'handoffs', `${predecessorSessionId}.md`);
    if (!existsSync(handoffPath)) return null;
    return readFileSync(handoffPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Schedule a respawn with exponential backoff.
 * Master agents get priority: RESPAWN_BASE_DELAY_MS / 2 base delay.
 * Other agents: RESPAWN_BASE_DELAY_MS * 2^respawnCount (5s, 10s, 20s by default).
 */
function scheduleRespawn(session: TrackedSession): void {
  const respawnCount = (session.respawnCount ?? 0) + 1;
  const role = session.spawnOptions!.role || 'unknown';
  const teamId = session.spawnOptions!.teamId || 'unknown';
  const isMaster = role === 'master';
  const baseDelay = isMaster ? Math.max(2000, Math.floor(RESPAWN_BASE_DELAY_MS / 2)) : RESPAWN_BASE_DELAY_MS;
  const delayMs = baseDelay * Math.pow(2, respawnCount - 1);

  logger.debug(
    `[SESSION MANAGER] Scheduling respawn #${respawnCount}/${MAX_RESPAWN_ATTEMPTS} ` +
    `for role=${role} team=${teamId} in ${delayMs}ms`
  );

  const predecessorSessionId = session.ahaSessionId;
  const predecessorHandoff = predecessorSessionId
    ? tryReadPredecessorHandoff(predecessorSessionId)
    : null;
  if (predecessorHandoff) {
    logger.debug(`[SESSION MANAGER] Found handoff note for predecessor ${predecessorSessionId}, will inject into respawn context`);
  }

  setTimeout(async () => {
    try {
      const respawnOptions: SpawnSessionOptions = {
        ...session.spawnOptions!,
        sessionId: undefined, // New session, don't recover the old one
        parentSessionId: predecessorSessionId ?? session.spawnOptions!.parentSessionId,
        env: {
          ...session.spawnOptions!.env,
          AHA_RESPAWN_COUNT: String(respawnCount),
          ...(predecessorHandoff ? { AHA_PREDECESSOR_HANDOFF: predecessorHandoff } : {}),
        },
      };

      const result = await spawnSession(respawnOptions);
      if (result.type === 'success' || result.type === 'queued') {
        logger.debug(
          `[SESSION MANAGER] Respawn #${respawnCount} accepted for role=${role} ` +
          `team=${teamId} → session=${result.sessionId}${result.type === 'queued' ? ` (queued at position ${result.queuePosition})` : ''}`
        );
      } else if (result.type === 'pending') {
        logger.debug(
          `[SESSION MANAGER] Respawn #${respawnCount} started for role=${role} ` +
          `team=${teamId} and is awaiting webhook binding (${result.pendingSessionId}, pid=${result.pid})`
        );
      } else {
        const errorMsg = result.type === 'error' ? result.errorMessage : 'unknown error';
        logger.debug(
          `[SESSION MANAGER] Respawn #${respawnCount} failed for role=${role} ` +
          `team=${teamId}: ${errorMsg}`
        );
      }
    } catch (error) {
      logger.debug(
        `[SESSION MANAGER] Respawn #${respawnCount} threw for role=${role} ` +
        `team=${teamId}: ${error instanceof Error ? error.message : 'unknown'}`
      );
    }
  }, delayMs);
}

/**
 * Called from the child process 'exit' event.
 * Removes the exited PID from the tracking map and triggers respawn if eligible.
 */
export const onChildExited = (pid: number): void => {
  const tracked = pidToTrackedSession.get(pid);
  logger.debug(`[SESSION MANAGER] Removing exited process PID ${pid} from tracking`);
  pidToTrackedSession.delete(pid);

  const teamId = tracked?.ahaSessionMetadataFromLocalWebhook?.teamId || tracked?.ahaSessionMetadataFromLocalWebhook?.roomId;
  if (teamId && tracked?.ahaSessionId) {
    helpAgentLeaseExpiryByTeam.get(teamId)?.delete(tracked.ahaSessionId);
  }

  if (tracked?.ahaSessionId && _onSessionDead) {
    _onSessionDead([tracked.ahaSessionId]);
  }

  // Auto-stash uncommitted changes before respawn to prevent code loss
  if (tracked && !tracked.intentionallyStopped) {
    tryAutoStash(tracked);
  }

  // Attempt auto-respawn for unexpectedly crashed agents
  if (tracked && isRespawnEligible(tracked)) {
    scheduleRespawn(tracked);
  }

  // Drain the spawn queue — a slot may have opened up
  drainSpawnQueue();
};
