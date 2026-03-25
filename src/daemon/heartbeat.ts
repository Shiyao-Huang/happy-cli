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

  // ── Step 4: Version drift detection ─────────────────────────────────────────
  let currentDiskVersion: string;
  try {
    currentDiskVersion = JSON.parse(
      readFileSync(join(projectPath(), 'package.json'), 'utf-8')
    ).version as string;
  } catch (error) {
    logger.debug('[HEARTBEAT] Failed to read package.json for version drift detection, skipping', error);
    currentDiskVersion = startupDiskVersion;
  }
  const restartMinUptimeMs = parseInt(
    process.env.AHA_DAEMON_VERSION_RESTART_MIN_UPTIME_MS || '120000',
    10
  );

  if (currentDiskVersion !== startupDiskVersion) {
    const uptimeMs = Date.now() - new Date(fileState.startTime).getTime();
    if (uptimeMs < restartMinUptimeMs) {
      logger.debug(
        `[HEARTBEAT] Version changed on disk (${startupDiskVersion} → ${currentDiskVersion}) ` +
        `but daemon uptime is only ${Math.round(uptimeMs / 1000)}s (< ${Math.round(restartMinUptimeMs / 1000)}s threshold) — skipping restart to avoid loop`
      );
    } else {
      logger.debug(
        `[HEARTBEAT] Version changed on disk (${startupDiskVersion} → ${currentDiskVersion}), triggering self-restart`
      );

      try {
        spawnAhaCLI(['daemon', 'start'], {
          detached: true,
          stdio: 'ignore',
        });
      } catch (error) {
        logger.debug('[HEARTBEAT] Failed to spawn new daemon — keeping current daemon alive', error);
        return;
      }

      // Poll for new daemon to become healthy (write its own state file with a different PID)
      const maxWaitMs = 15_000;
      const pollIntervalMs = 500;
      const startedAt = Date.now();
      let newDaemonHealthy = false;

      while (Date.now() - startedAt < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        try {
          const newState = await readDaemonState();
          if (newState && newState.pid !== process.pid) {
            // Verify the new daemon PID is actually alive
            process.kill(newState.pid, 0);
            newDaemonHealthy = true;
            logger.debug(`[HEARTBEAT] New daemon (PID ${newState.pid}) is healthy — old daemon exiting`);
            break;
          }
        } catch {
          // New daemon not ready yet or PID not alive, keep polling
        }
      }

      if (newDaemonHealthy) {
        clearInterval(heartbeatIntervalHandle);
        process.exit(0);
      } else {
        logger.debug('[HEARTBEAT] New daemon failed to start within timeout — keeping current daemon alive');
        return;
      }
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
