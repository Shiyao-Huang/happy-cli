/**
 * @module heartbeat
 * @description Daemon heartbeat cycle: prune stale sessions, write state file, detect version upgrades.
 *
 * ```mermaid
 * graph TD
 *   A[run.ts] -->|runHeartbeatCycle| B[heartbeat]
 *   B -->|reads| C[pidToTrackedSession]
 *   B -->|reportDeadSessions| D[apiMachine]
 *   B -->|writeDaemonState| E[persistence]
 *   B -->|pingHeartbeat| F[teamHeartbeats]
 * ```
 *
 * ## Exports
 * - `HeartbeatContext` — inputs required by a single heartbeat cycle
 * - `HeartbeatResult` — output of a heartbeat cycle (dead sessions, version change)
 * - `runHeartbeatCycle` — execute one tick of the heartbeat loop
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { logger } from '@/ui/logger';
import { writeDaemonState, readDaemonState, DaemonLocallyPersistedState } from '@/persistence';
import { spawnAhaCLI } from '@/utils/spawnAhaCLI';
import { projectPath } from '@/projectPath';
import { TrackedSession } from './types';
import { AgentHeartbeat } from '@/claude/team/heartbeat';

// ── Context type ───────────────────────────────────────────────────────────────

export interface HeartbeatContext {
  /** Live session map (read-only from heartbeat perspective) */
  pidToTrackedSession: Map<number, TrackedSession>;
  /** Ping a session's heartbeat tracker (forwarded to teamHeartbeats in run.ts) */
  pingHeartbeat: (session: TrackedSession) => void;
  /** Report dead session IDs to the backend */
  reportDeadSessions: (ids: string[]) => void;
  /**
   * Called when a stale session is pruned during heartbeat.
   * Allows sessionManager to trigger respawn and drain the spawn queue.
   */
  onSessionDied?: (deadSession: TrackedSession) => void;
  /** Request daemon shutdown on integrity failures */
  requestShutdown: (source: 'aha-app' | 'aha-cli' | 'os-signal' | 'exception', msg?: string) => void;
  /** The on-disk version string recorded at daemon startup (used for drift detection) */
  startupDiskVersion: string;
  /** The persisted daemon state written at startup (used to detect pid mismatches) */
  fileState: DaemonLocallyPersistedState;
  /** The HTTP port this daemon is listening on */
  controlPort: number;
  /** Reference to the setInterval handle so we can clearInterval on self-restart */
  heartbeatIntervalHandle: ReturnType<typeof setInterval>;
  /** MCP-layer heartbeat trackers per team (for cross-checking zombie sessions) */
  teamHeartbeats?: Map<string, AgentHeartbeat>;
}

export interface HeartbeatResult {
  /** sessionIds that were found dead and removed this cycle */
  deadSessionIds: string[];
  /** True if a version upgrade was detected and the daemon initiated self-restart */
  selfRestarted: boolean;
}

let versionRestartInFlight = false;

function readCurrentDiskVersion(fallbackVersion: string): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(projectPath(), 'package.json'), 'utf-8')
    ) as { version?: unknown };

    if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
      return packageJson.version;
    }

    logger.warn('[HEARTBEAT] package.json version missing during heartbeat; using startup version fallback');
  } catch (error) {
    logger.warn(
      '[HEARTBEAT] Failed to read package.json during heartbeat; using startup version fallback',
      error instanceof Error ? error.message : String(error)
    );
  }

  return fallbackVersion;
}

async function waitForReplacementDaemon(params: {
  currentPid: number;
  expectedVersion: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < params.timeoutMs) {
    const daemonState = await readDaemonState().catch(() => null);
    const replacementPid = daemonState?.pid;

    if (
      daemonState &&
      typeof replacementPid === 'number' &&
      replacementPid > 0 &&
      replacementPid !== params.currentPid &&
      daemonState.startedWithCliVersion === params.expectedVersion
    ) {
      try {
        process.kill(replacementPid, 0);
        return true;
      } catch {
        // Replacement state file exists, but the PID is not healthy yet.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
  }

  return false;
}

// ── Heartbeat cycle ────────────────────────────────────────────────────────────

/**
 * Execute one tick of the daemon heartbeat.
 *
 * Steps:
 * 1. Prune stale sessions (send signal 0, remove dead PIDs, report to backend)
 * 2. Cross-check MCP-layer heartbeat for zombie sessions (PID alive but MCP silent)
 * 3. Ping liveness heartbeat for alive sessions
 * 4. Detect disk-version upgrade → spawn new daemon and exit
 * 5. Verify we still own the daemon state file (PID check)
 * 6. Write updated heartbeat timestamp to daemon state file
 */
export async function runHeartbeatCycle(ctx: HeartbeatContext): Promise<HeartbeatResult> {
  const {
    pidToTrackedSession,
    pingHeartbeat,
    reportDeadSessions,
    onSessionDied,
    requestShutdown,
    startupDiskVersion,
    fileState,
    controlPort,
    heartbeatIntervalHandle,
  } = ctx;

  // ── Step 1: Prune stale sessions ────────────────────────────────────────────
  const deadSessionIds: string[] = [];
  for (const [pid] of pidToTrackedSession.entries()) {
    try {
      process.kill(pid, 0); // signal 0: liveness check, no-op if alive
    } catch {
      const tracked = pidToTrackedSession.get(pid);
      logger.debug(`[HEARTBEAT] Removing stale session with PID ${pid} (process no longer exists)`);
      pidToTrackedSession.delete(pid);
      if (tracked?.ahaSessionId) {
        deadSessionIds.push(tracked.ahaSessionId);
      }
      // Notify sessionManager for potential respawn and queue drain
      if (tracked) {
        onSessionDied?.(tracked);
      }
    }
  }
  if (deadSessionIds.length > 0) {
    reportDeadSessions(deadSessionIds);
  }

  // ── Step 2: Cross-check MCP-layer heartbeat for zombie sessions ────────────
  // A "zombie" is a session whose PID is alive but Claude has stopped making
  // MCP tool calls (e.g., context exhausted, session frozen). The MCP-layer
  // AgentHeartbeat marks these as "dead" after 90s of silence, but previously
  // this information was never propagated to the backend.
  const mcpDeadSessionIds: string[] = [];
  if (ctx.teamHeartbeats) {
    const alivePids = new Set(
      Array.from(pidToTrackedSession.values())
        .filter(s => s.ahaSessionId)
        .map(s => s.ahaSessionId!)
    );
    for (const [, hb] of ctx.teamHeartbeats) {
      for (const dead of hb.getDeadAgents()) {
        // Only report if the PID is still alive (true zombie — PID alive, MCP dead)
        if (alivePids.has(dead.agentId) && !deadSessionIds.includes(dead.agentId)) {
          mcpDeadSessionIds.push(dead.agentId);
          logger.debug(
            `[HEARTBEAT] MCP-layer zombie detected: session ${dead.agentId} (role=${dead.role}) ` +
            `— PID alive but no MCP activity for ${Math.round(dead.deadForMs / 1000)}s`
          );
        }
      }
    }
  }
  if (mcpDeadSessionIds.length > 0) {
    reportDeadSessions(mcpDeadSessionIds);
  }

  // ── Step 3: Ping alive sessions ─────────────────────────────────────────────
  for (const session of pidToTrackedSession.values()) {
    pingHeartbeat(session);
  }

  // ── Step 3: Version drift detection ─────────────────────────────────────────
  const currentDiskVersion = readCurrentDiskVersion(startupDiskVersion);
  const restartMinUptimeMs = parseInt(
    process.env.AHA_DAEMON_VERSION_RESTART_MIN_UPTIME_MS || '120000',
    10
  );
  const replacementHealthTimeoutMs = parseInt(
    process.env.AHA_DAEMON_REPLACEMENT_HEALTH_TIMEOUT_MS || '15000',
    10
  );
  const replacementHealthPollMs = parseInt(
    process.env.AHA_DAEMON_REPLACEMENT_HEALTH_POLL_MS || '500',
    10
  );

  if (currentDiskVersion !== startupDiskVersion) {
    const uptimeMs = Date.now() - new Date(fileState.startTime).getTime();
    if (uptimeMs < restartMinUptimeMs) {
      logger.debug(
        `[HEARTBEAT] Version changed on disk (${startupDiskVersion} → ${currentDiskVersion}) ` +
        `but daemon uptime is only ${Math.round(uptimeMs / 1000)}s (< ${Math.round(restartMinUptimeMs / 1000)}s threshold) — skipping restart to avoid loop`
      );
    } else if (!versionRestartInFlight) {
      versionRestartInFlight = true;
      logger.debug(
        `[HEARTBEAT] Version changed on disk (${startupDiskVersion} → ${currentDiskVersion}), triggering self-restart`
      );

      try {
        spawnAhaCLI(['daemon', 'start'], {
          detached: true,
          stdio: 'ignore',
        });
      } catch (error) {
        logger.debug('[HEARTBEAT] Failed to spawn new daemon', error);
        versionRestartInFlight = false;
        return { deadSessionIds, selfRestarted: false };
      }

      const replacementHealthy = await waitForReplacementDaemon({
        currentPid: process.pid,
        expectedVersion: currentDiskVersion,
        timeoutMs: replacementHealthTimeoutMs,
        pollIntervalMs: replacementHealthPollMs,
      });

      if (!replacementHealthy) {
        versionRestartInFlight = false;
        logger.warn(
          `[HEARTBEAT] Replacement daemon did not become healthy within ${replacementHealthTimeoutMs}ms; keeping current daemon alive`
        );
        return { deadSessionIds, selfRestarted: false };
      }

      clearInterval(heartbeatIntervalHandle);
      logger.debug('[HEARTBEAT] Replacement daemon is healthy; exiting old daemon process');
      process.exit(0);
    } else {
      logger.debug('[HEARTBEAT] Version restart already in flight; skipping duplicate restart');
    }
  }

  // ── Step 5: PID integrity check ──────────────────────────────────────────────
  const daemonState = await readDaemonState();
  if (daemonState && daemonState.pid !== process.pid) {
    logger.debug('[HEARTBEAT] Somehow a different daemon was started without killing us. We should kill ourselves.');
    requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.');
  }

  // ── Step 6: Write heartbeat timestamp ───────────────────────────────────────
  try {
    const updatedState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: fileState.startTime,
      startedWithCliVersion: startupDiskVersion,
      startedWithBuildHash: fileState.startedWithBuildHash ?? null,
      runtimeEntrypoint: fileState.runtimeEntrypoint ?? null,
      lastHeartbeat: new Date().toLocaleString(),
      daemonLogPath: fileState.daemonLogPath,
    };
    writeDaemonState(updatedState);
    if (process.env.DEBUG) {
      logger.debug(`[HEARTBEAT] Health check completed at ${updatedState.lastHeartbeat}`);
    }
  } catch (error) {
    logger.debug('[HEARTBEAT] Failed to write heartbeat', error);
  }

  return { deadSessionIds, selfRestarted: false };
}
