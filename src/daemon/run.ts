/**
 * @module run
 * @description Daemon entry point: lifecycle, signals, lock, auth, heartbeat orchestration.
 *
 * ```mermaid
 * graph TD
 *   A[run.ts] -->|imports| B[sessionManager]
 *   A -->|imports| C[heartbeat]
 *   A -->|imports| D[supervisorScheduler]
 *   B -->|pidToTrackedSession| C
 *   B -->|pidToTrackedSession| D
 *   D -->|spawnSession| B
 *   D -->|requestHelp| B
 * ```
 *
 * ## Responsibilities
 * - Shutdown promise + OS signal handlers
 * - Version mismatch check + daemon lock
 * - caffeinate + auth setup
 * - team heartbeat tracking (AgentHeartbeat per team)
 * - control server wiring
 * - API client, machine registration, WebSocket connect
 * - heartbeat setInterval (orchestrates heartbeat.ts + supervisorScheduler.ts)
 * - cleanup + shutdown
 */

import os from 'os';

import { ApiClient } from '@/api/api';
import { ApiMachineClient } from '@/api/apiMachine';
import { AgentHeartbeat, AgentHealthStatus } from '@/claude/team/heartbeat';
import { MachineMetadata, DaemonState, Machine } from '@/api/types';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { getReconnectSeed, persistCredentials } from '@/auth/reconnect';
import { authGetToken } from '@/api/auth';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import axios from 'axios';
import { getEnvironmentInfo } from '@/ui/doctor';
import { writeDaemonState, DaemonLocallyPersistedState, acquireDaemonLock, releaseDaemonLock } from '@/persistence';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledAhaVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { TrackedSession } from './types';

import {
  pidToTrackedSession,
  initSessionManagerHeartbeat,
  onAhaSessionWebhook,
  spawnSession,
  stopSession,
  stopTeamSessions,
  requestHelp,
  recoverExistingSessions,
} from './sessionManager';

import { runHeartbeatCycle } from './heartbeat';
import { runSupervisorCycle, collectLiveMainlineSessionIdsByTeam } from './supervisorScheduler';

// Prepare initial metadata — use configuration.currentCliVersion (reads from disk)
// instead of compiled packageJson.version to avoid stale version after bump-without-rebuild.
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  ahaCliVersion: configuration.currentCliVersion,
  homeDir: os.homedir(),
  ahaHomeDir: configuration.ahaHomeDir,
  ahaLibDir: projectPath()
};

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'aha-app' | 'aha-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let shutdownForceExitTimer: ReturnType<typeof setTimeout> | null = null;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'aha-app' | 'aha-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case shutdown cleanup hangs forever.
      if (!shutdownForceExitTimer) {
        shutdownForceExitTimer = setTimeout(async () => {
          logger.debug('[DAEMON RUN] Shutdown cleanup timed out, forcing exit with code 1');

          // Give time for logs to be flushed
          await new Promise(resolve => setTimeout(resolve, 100))

          process.exit(1);
        }, 10_000);
      }

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledAhaVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    let { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // ── Per-team agent heartbeat tracking ─────────────────────────────────────
    const teamHeartbeats = new Map<string, AgentHeartbeat>();

    const getOrCreateTeamHeartbeat = (teamId: string): AgentHeartbeat => {
      let hb = teamHeartbeats.get(teamId);
      if (!hb) {
        hb = new AgentHeartbeat(90_000, 60_000); // 90s dead, 60s suspect (daemon checks every 60s)
        hb.startMonitoring(30_000);
        teamHeartbeats.set(teamId, hb);
        logger.debug(`[DAEMON RUN] Created heartbeat tracker for team ${teamId}`);
      }
      return hb;
    };

    /** Ping heartbeat for a session if it belongs to a team */
    const pingHeartbeat = (session: TrackedSession) => {
      const meta = session.ahaSessionMetadataFromLocalWebhook;
      const teamId = meta?.teamId || meta?.roomId;
      if (!teamId || !session.ahaSessionId) return;
      const hb = getOrCreateTeamHeartbeat(teamId);
      hb.ping(session.ahaSessionId, meta?.role || 'unknown', []);
    };

    /** Get team pulse snapshot for control server */
    const getTeamPulse = (teamId: string): Array<{
      sessionId: string;
      role: string;
      status: AgentHealthStatus;
      lastSeenMs: number;
      pid?: number;
      runtimeType?: string;
    }> => {
      const hb = teamHeartbeats.get(teamId);
      const children = Array.from(pidToTrackedSession.values());
      const teamChildren = children.filter(c => {
        const meta = c.ahaSessionMetadataFromLocalWebhook;
        return (meta?.teamId || meta?.roomId) === teamId && c.ahaSessionId;
      });

      if (!hb) {
        return teamChildren.map(c => ({
          sessionId: c.ahaSessionId!,
          role: c.ahaSessionMetadataFromLocalWebhook?.role || 'unknown',
          status: 'alive' as AgentHealthStatus,
          lastSeenMs: 0,
          pid: c.pid,
          runtimeType: c.ahaSessionMetadataFromLocalWebhook?.flavor,
        }));
      }

      const allAgents = hb.getAllAgents();
      const agentMap = new Map(allAgents.map(a => [a.agentId, a]));

      return teamChildren.map(c => {
        const entry = agentMap.get(c.ahaSessionId!);
        return {
          sessionId: c.ahaSessionId!,
          role: c.ahaSessionMetadataFromLocalWebhook?.role || 'unknown',
          status: entry?.status ?? 'alive',
          lastSeenMs: entry ? Date.now() - entry.lastSeen : 0,
          pid: c.pid,
          runtimeType: c.ahaSessionMetadataFromLocalWebhook?.flavor,
        };
      });
    };

    // Wire heartbeat ping into sessionManager
    initSessionManagerHeartbeat(pingHeartbeat);

    // Helper for control server
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // ── Start control server ───────────────────────────────────────────────────
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      stopTeamSessions,
      spawnSession,
      requestShutdown: () => requestShutdown('aha-cli'),
      onAhaSessionWebhook,
      getTeamPulse,
      requestHelp,
      onHeartbeatPing: (sessionId: string, teamId: string, role: string) => {
        const hb = getOrCreateTeamHeartbeat(teamId);
        hb.ping(sessionId, role, []);
      },
      onClaudeLocalSessionFound: (ahaSessionId, claudeLocalSessionId) => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
          if (session.ahaSessionId === ahaSessionId) {
            pidToTrackedSession.set(pid, { ...session, claudeLocalSessionId });
            logger.debug(`[DAEMON RUN] Mapped aha session ${ahaSessionId} → claude local ${claudeLocalSessionId}`);
            break;
          }
        }
      },
    });

    // Read version from disk (not compiled import) to avoid build/publish desync.
    const diskVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;

    // Write initial daemon state
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: diskVersion,
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug(`[DAEMON RUN] Daemon state written (version: ${diskVersion})`);

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    let api = await ApiClient.create(credentials);
    let machine: Machine | null = null;
    let apiMachine: ApiMachineClient | null = null;

    const attachRemoteMachineClient = (registeredMachine: Machine) => {
      const nextApiMachine = api.machineSyncClient(registeredMachine);
      nextApiMachine.setRPCHandlers({
        spawnSession,
        stopSession,
        requestHelp,
        requestShutdown: () => requestShutdown('aha-app')
      });
      nextApiMachine.connect();
      apiMachine = nextApiMachine;
      logger.debug(`[DAEMON RUN] Remote machine sync connected for machine ${registeredMachine.id}`);
    };

    const tryRegisterMachine = async (reason: 'startup' | 'heartbeat'): Promise<boolean> => {
      const register = () => api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata,
        daemonState: initialDaemonState
      });

      try {
        machine = await register();
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          logger.debug(`[DAEMON RUN] Machine registration failed with 401 during ${reason}, attempting token refresh via create mode...`);

          const reconnectSeed = getReconnectSeed(credentials);
          if (!reconnectSeed) {
            throw new Error('Cannot refresh token: no reconnect seed available in credentials');
          }

          const newToken = await authGetToken(reconnectSeed, 'create');
          credentials = { ...credentials, token: newToken };
          await persistCredentials(credentials);
          logger.debug(`[DAEMON RUN] Token refreshed and persisted during ${reason}, retrying machine registration...`);

          api = await ApiClient.create(credentials);

          try {
            machine = await register();
          } catch (retryError) {
            if (axios.isAxiosError(retryError) && (retryError.response?.status ?? 0) >= 500) {
              logger.warn(`[DAEMON RUN] Remote machine registration failed (${retryError.response?.status}) during ${reason}; starting in offline mode and will retry on a future heartbeat.`);
              machine = null;
              return false;
            }
            throw retryError;
          }
        } else if (axios.isAxiosError(error) && (error.response?.status ?? 0) >= 500) {
          logger.warn(`[DAEMON RUN] Remote machine registration failed (${error.response?.status}) during ${reason}; starting in offline mode and will retry on a future heartbeat.`);
          machine = null;
          return false;
        } else {
          throw error;
        }
      }

      logger.debug(`[DAEMON RUN] Machine registered (${reason}): ${machine.id}`);

      if (!apiMachine) {
        attachRemoteMachineClient(machine);
      }

      return true;
    };

    await tryRegisterMachine('startup');

    if (!apiMachine) {
      logger.warn('[DAEMON RUN] Running in LOCAL-ONLY mode — remote machine not registered. RPC sync and remote dead-session reporting will remain disabled until reconnected.');
    }

    // ── Heartbeat interval configuration ──────────────────────────────────────
    const heartbeatIntervalMs = parseInt(process.env.AHA_DAEMON_HEARTBEAT_INTERVAL || '60000');
    const pendingActionBaseRetryMs = Math.max(
      heartbeatIntervalMs,
      parseInt(process.env.AHA_SUPERVISOR_PENDING_ACTION_RETRY_BASE_MS || '60000')
    );
    const supervisorTerminateIdleMs = parseInt(
      process.env.AHA_SUPERVISOR_TERMINATE_IDLE_MS || `${24 * 60 * 60 * 1000}`
    );
    const supervisorInterval = parseInt(process.env.AHA_SUPERVISOR_INTERVAL || '20');

    let heartbeatRunning = false;
    let heartbeatCount = 0;

    // ── Heartbeat interval ─────────────────────────────────────────────────────
    // Every heartbeatIntervalMs (default 60s):
    //   1. runHeartbeatCycle — prune stale sessions, version check, write state file
    //   2. runSupervisorCycle — pending action retry, supervisor spawn scheduling
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      if (!machine || !apiMachine) {
        await tryRegisterMachine('heartbeat');
      }

      await runHeartbeatCycle({
        pidToTrackedSession,
        pingHeartbeat,
        reportDeadSessions: (ids) => {
          if (!apiMachine) {
            return;
          }
          apiMachine.reportDeadSessions(ids);
        },
        requestShutdown: (source, msg) => requestShutdown(source, msg),
        startupDiskVersion: diskVersion,
        fileState,
        controlPort,
        heartbeatIntervalHandle: restartOnStaleVersionAndHeartbeat,
      });

      heartbeatCount++;

      await runSupervisorCycle({
        pidToTrackedSession,
        heartbeatCount,
        supervisorInterval,
        supervisorTerminateIdleMs,
        pendingActionBaseRetryMs,
        heartbeatIntervalMs,
        credentialsToken: credentials.token,
        spawnSession,
        requestHelp,
      });

      heartbeatRunning = false;
    }, heartbeatIntervalMs);

    // ── Cleanup + shutdown ─────────────────────────────────────────────────────
    const cleanupAndShutdown = async (source: 'aha-app' | 'aha-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Remove state early so callers immediately observe that the daemon is shutting down.
      await cleanupDaemonState();

      if (shutdownForceExitTimer) {
        clearTimeout(shutdownForceExitTimer);
        shutdownForceExitTimer = null;
      }

      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      if (apiMachine) {
        await apiMachine.updateDaemonState((state: DaemonState | null) => ({
          ...state,
          status: 'shutting-down',
          shutdownRequestedAt: Date.now(),
          shutdownSource: source
        }));

        await new Promise(resolve => setTimeout(resolve, 100));

        apiMachine.shutdown();
      } else {
        logger.warn('[DAEMON RUN] Shutting down in LOCAL-ONLY mode — no remote machine client to update or close.');
      }

      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Recover already-running sessions from previous daemon instance
    const recoveredCount = recoverExistingSessions();
    if (recoveredCount > 0) {
      logger.debug(`[DAEMON RUN] Recovered ${recoveredCount} sessions from previous daemon instance`);
    }

    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
