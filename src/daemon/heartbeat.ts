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

// ── Context type ───────────────────────────────────────────────────────────────

export interface HeartbeatContext {
  /** Live session map (read-only from heartbeat perspective) */
  pidToTrackedSession: Map<number, TrackedSession>;
  /** Ping a session's heartbeat tracker (forwarded to teamHeartbeats in run.ts) */
  pingHeartbeat: (session: TrackedSession) => void;
  /** Report dead session IDs to the backend */
  reportDeadSessions: (ids: string[]) => void;
  /** Request daemon shutdown on integrity failures */
  requestShutdown: (source: 'exception', msg: string) => void;
  /** The on-disk version string recorded at daemon startup (used for drift detection) */
  startupDiskVersion: string;
  /** The persisted daemon state written at startup (used to detect pid mismatches) */
  fileState: DaemonLocallyPersistedState;
  /** The HTTP port this daemon is listening on */
  controlPort: number;
  /** Reference to the setInterval handle so we can clearInterval on self-restart */
  heartbeatIntervalHandle: ReturnType<typeof setInterval>;
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
 * 2. Ping liveness heartbeat for alive sessions
 * 3. Detect disk-version upgrade → spawn new daemon and exit
 * 4. Verify we still own the daemon state file (PID check)
 * 5. Write updated heartbeat timestamp to daemon state file
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

  // ── Step 2: Ping alive sessions ─────────────────────────────────────────────
  for (const session of pidToTrackedSession.values()) {
    pingHeartbeat(session);
  }

  // ── Step 3: Version drift detection ─────────────────────────────────────────
  const currentDiskVersion = JSON.parse(
    readFileSync(join(projectPath(), 'package.json'), 'utf-8')
  ).version as string;

  if (currentDiskVersion !== startupDiskVersion) {
    const uptimeMs = Date.now() - new Date(fileState.startTime).getTime();
    if (uptimeMs < 120_000) {
      logger.debug(
        `[HEARTBEAT] Version changed on disk (${startupDiskVersion} → ${currentDiskVersion}) ` +
        `but daemon uptime is only ${Math.round(uptimeMs / 1000)}s — skipping restart to avoid loop`
      );
    } else {
      logger.debug(
        `[HEARTBEAT] Version changed on disk (${startupDiskVersion} → ${currentDiskVersion}), triggering self-restart`
      );

      clearInterval(heartbeatIntervalHandle);

      try {
        spawnAhaCLI(['daemon', 'start'], {
          detached: true,
          stdio: 'ignore',
        });
      } catch (error) {
        logger.debug('[HEARTBEAT] Failed to spawn new daemon', error);
      }

      logger.debug('[HEARTBEAT] Hanging for a bit - waiting for CLI to kill us');
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      process.exit(0);
    }
  }

  // ── Step 4: PID integrity check ──────────────────────────────────────────────
  const daemonState = await readDaemonState();
  if (daemonState && daemonState.pid !== process.pid) {
    logger.debug('[HEARTBEAT] Somehow a different daemon was started without killing us. We should kill ourselves.');
    requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.');
  }

  // ── Step 5: Write heartbeat timestamp ───────────────────────────────────────
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
