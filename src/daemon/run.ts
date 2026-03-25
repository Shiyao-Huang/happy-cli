import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
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
import { ChannelRouter } from '@/channels/router';
import { PushPolicy } from '@/channels/types';
import { deleteWeixinCredentials, loadPushPolicy, loadWeixinCredentials, savePushPolicy, setWeixinEnabled } from '@/channels/weixin/config';
import { WeixinBridge } from '@/channels/weixin/bridge';
import { MachineMetadata, DaemonState, Machine } from '@/api/types';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { getReconnectSeed, persistCredentials } from '@/auth/reconnect';
import { authGetToken } from '@/api/auth';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import axios from 'axios';
import { getEnvironmentInfo } from '@/ui/doctor';
import { writeDaemonState, DaemonLocallyPersistedState, acquireDaemonLock, releaseDaemonLock, readSettings } from '@/persistence';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { projectPath } from '@/projectPath';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledAhaVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { TrackedSession } from './types';

import {
  pidToTrackedSession,
  initSessionManagerHeartbeat,
  initSessionManagerDeadCallback,
  onAhaSessionWebhook,
  spawnSession,
  stopSession,
  stopTeamSessions,
  requestHelp,
  recoverExistingSessions,
  onHeartbeatPrunedSession,
} from './sessionManager';

import { runHeartbeatCycle } from './heartbeat';
import { runSupervisorCycle } from './supervisorScheduler';
import { shouldUsePidHeartbeat } from './heartbeatPolicy';

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

/**
 * Ensure genome-hub is reachable and the publish key is configured.
 *
 * 1. Applies `genomeHubPublishKey` from settings → `process.env.HUB_PUBLISH_KEY`
 *    so all spawned agent sessions inherit it without manual env setup.
 * 2. If genome-hub is unreachable at `GENOME_HUB_URL` (default aha-agi.com/genome),
 *    and `genomeHubSshHost` is set in settings (or `GENOME_HUB_SSH_HOST` env var),
 *    creates an SSH port-forwarding tunnel: local 3006 → remote 3006.
 *
 * Returns the tunnel child process PID (or 0 if no tunnel was created).
 */
async function ensureGenomeHubAccess(): Promise<number> {
  const settings = await readSettings();

  // 1. Inject publish key into process env so child processes inherit it
  const publishKey = process.env.HUB_PUBLISH_KEY || settings.genomeHubPublishKey || '';
  if (publishKey && !process.env.HUB_PUBLISH_KEY) {
    process.env.HUB_PUBLISH_KEY = publishKey;
    logger.debug('[GENOME HUB] Loaded HUB_PUBLISH_KEY from settings');
  }
  if (!publishKey) {
    logger.warn('[GENOME HUB] HUB_PUBLISH_KEY not set and genomeHubPublishKey missing from settings — genome feedback uploads will fail with 401');
  }

  // 2. Check reachability and optionally create SSH tunnel
  const hubUrl = (process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
  if (!process.env.GENOME_HUB_URL) {
    logger.warn(`[GENOME HUB] GENOME_HUB_URL not set, falling back to ${DEFAULT_GENOME_HUB_URL}`);
  }
  const sshHost = process.env.GENOME_HUB_SSH_HOST || settings.genomeHubSshHost || '';

  if (!sshHost) {
    logger.warn('[GENOME HUB] genomeHubSshHost not configured — no SSH tunnel will be created; genome-hub must be accessible at ' + hubUrl);
    return 0; // No tunnel configured — assume genome-hub is accessible directly
  }

  // Quick reachability check
  try {
    await axios.get(`${hubUrl}/health`, { timeout: 3000 });
    logger.debug(`[GENOME HUB] Reachable at ${hubUrl} — no tunnel needed`);
    return 0;
  } catch {
    logger.debug(`[GENOME HUB] Not reachable at ${hubUrl} — attempting SSH tunnel via ${sshHost}`);
  }

  // Parse port from hubUrl (default 3006)
  const localPort = new URL(hubUrl).port || '3006';

  return new Promise<number>((resolve) => {
    const tunnel = spawn('ssh', [
      '-f',                          // background after auth
      '-N',                          // no remote command
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-L', `${localPort}:localhost:${localPort}`,
      sshHost,
    ], { stdio: 'ignore', detached: true });

    tunnel.on('error', (err) => {
      logger.debug(`[GENOME HUB] SSH tunnel spawn error: ${err.message}`);
      resolve(0);
    });

    tunnel.on('close', (code) => {
      if (code !== 0 && code !== null) {
        logger.debug(`[GENOME HUB] SSH tunnel exited with code ${code}`);
        resolve(0);
      }
    });

    // Give tunnel 3s to establish, then verify reachability
    setTimeout(async () => {
      try {
        await axios.get(`${hubUrl}/health`, { timeout: 3000 });
        logger.debug(`[GENOME HUB] SSH tunnel established via ${sshHost} — genome-hub reachable`);
        resolve(tunnel.pid ?? 0);
      } catch {
        logger.debug(`[GENOME HUB] SSH tunnel created but genome-hub still unreachable at ${hubUrl}`);
        resolve(tunnel.pid ?? 0);
      }
    }, 3000);
  });
}

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

  process.on('SIGHUP', () => {
    logger.debug('[DAEMON RUN] Received SIGHUP (terminal closed)');
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

  let stopControlServer: (() => Promise<void>) | null = null;
  let restartOnStaleVersionAndHeartbeat: ReturnType<typeof setInterval> | null = null;
  let caffeinateStarted = false;
  let channelRouter: ChannelRouter | null = null;

  try {
    // Start caffeinate
    caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    let { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');
    let api = await ApiClient.create(credentials);

    // ── Genome hub access: SSH tunnel + publish key injection ─────────────────
    await ensureGenomeHubAccess();

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

    /** Ping heartbeat for a session if it belongs to a team.
     *
     * Default behavior is stability-first: PID heartbeat stays enabled even after a
     * Claude local session is established. The strict MCP-only mode caused active Claude
     * agents to be declared dead during long reasoning / non-tool phases because many
     * legitimate execution paths exceed the 90s MCP silence threshold.
     *
     * If we want to experiment with strict zombie detection again, gate it behind
     * AHA_STRICT_CLAUDE_MCP_HEARTBEAT=true instead of making it the default.
     */
    const pingHeartbeat = (session: TrackedSession) => {
      const meta = session.ahaSessionMetadataFromLocalWebhook;
      const teamId = meta?.teamId || meta?.roomId;
      if (!teamId || !session.ahaSessionId) return;

      if (!shouldUsePidHeartbeat(session)) return;

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
      contextUsedPercent?: number;
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
        let status: AgentHealthStatus = entry?.status ?? 'alive';

        // PID-aware override: if heartbeat says "dead" but process is still alive,
        // the agent is idle (no MCP tool calls), not actually dead.
        if (status === 'dead' && c.pid) {
          try {
            process.kill(c.pid, 0); // signal 0 = liveness probe, no-op if alive
            status = 'suspect'; // Alive process + stale heartbeat = idle, not dead
          } catch {
            // PID gone — confirmed dead
          }
        }

        return {
          sessionId: c.ahaSessionId!,
          role: c.ahaSessionMetadataFromLocalWebhook?.role || 'unknown',
          status,
          lastSeenMs: entry ? Date.now() - entry.lastSeen : 0,
          pid: c.pid,
          runtimeType: c.ahaSessionMetadataFromLocalWebhook?.flavor,
          contextUsedPercent: entry?.contextUsedPercent,
        };
      });
    };

    // Wire heartbeat ping into sessionManager
    initSessionManagerHeartbeat(pingHeartbeat);

    // Wire dead session reporting so onChildExited can notify the backend immediately
    initSessionManagerDeadCallback((ids) => {
      if (apiMachine) {
        apiMachine.reportDeadSessions(ids);
      }
    });

    // Helper for control server
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // ── Channel router (WeChat IM) ────────────────────────────────────────────
    channelRouter = new ChannelRouter(() => api);
    let weixinBridge: WeixinBridge | null = null;

    const connectWeixinFromSavedCreds = async (): Promise<{ success: boolean; error?: string }> => {
      const creds = loadWeixinCredentials();
      if (!creds) {
        return { success: false, error: 'No saved WeChat credentials found. Run `aha channels weixin login` first.' };
      }

      try {
        if (weixinBridge) {
          await weixinBridge.disconnect();
          channelRouter.unregisterChannel('weixin');
        }

        weixinBridge = new WeixinBridge();
        channelRouter.registerChannel(weixinBridge);
        await weixinBridge.connect(creds);
        setWeixinEnabled(true);

        logger.debug('[DAEMON RUN] WeChat bridge connected from saved credentials');
        return { success: true };
      } catch (error) {
        if (weixinBridge) {
          channelRouter.unregisterChannel('weixin');
          weixinBridge = null;
        }
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    const disconnectWeixinBridge = async (): Promise<{ success: boolean; error?: string }> => {
      try {
        if (weixinBridge) {
          await weixinBridge.disconnect();
          channelRouter.unregisterChannel('weixin');
          weixinBridge = null;
        }
        deleteWeixinCredentials();
        setWeixinEnabled(false);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    const setWeixinPushPolicy = async (policy: PushPolicy): Promise<{ success: boolean; error?: string }> => {
      try {
        savePushPolicy(policy);
        setWeixinEnabled(true);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    const getChannelStatus = () => {
      const creds = loadWeixinCredentials();
      return {
        weixin: creds ? {
          configured: true,
          connected: Boolean(weixinBridge?.connected),
          pushPolicy: loadPushPolicy(),
        } : null,
      };
    };

    // ── Start control server ───────────────────────────────────────────────────
    const { port: controlPort, stop: nextStopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      stopTeamSessions,
      spawnSession,
      requestShutdown: () => requestShutdown('aha-cli'),
      onAhaSessionWebhook,
      getTeamPulse,
      requestHelp,
      getChannelStatus,
      connectWeixin: connectWeixinFromSavedCreds,
      disconnectWeixin: disconnectWeixinBridge,
      setWeixinPushPolicy,
      onChannelNotify: (event) => channelRouter.pushToIM(event),
      onHeartbeatPing: (sessionId: string, teamId: string, role: string, contextUsedPercent?: number) => {
        const hb = getOrCreateTeamHeartbeat(teamId);
        hb.ping(sessionId, role, [], contextUsedPercent);
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
    stopControlServer = nextStopControlServer;

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

    let machine: Machine | null = null;
    let apiMachine: ApiMachineClient | null = null;

    if (loadWeixinCredentials()) {
      const weixinResult = await connectWeixinFromSavedCreds();
      if (!weixinResult.success) {
        logger.warn(`[DAEMON RUN] Failed to auto-connect WeChat bridge: ${weixinResult.error}`);
      }
    }

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
        if (axios.isAxiosError(error) && error.response?.status === 409) {
          // Machine belongs to a different account — clear local machineId and generate a new one
          logger.warn(`[DAEMON RUN] Machine ID ${machineId} belongs to another account (409). Clearing machineId and generating a new one...`);
          const { clearMachineId, updateSettings } = await import('@/persistence');
          await clearMachineId();
          const { randomUUID } = await import('node:crypto');
          const newMachineId = randomUUID();
          await updateSettings(s => ({ ...s, machineId: newMachineId }));
          machineId = newMachineId;
          logger.debug(`[DAEMON RUN] New machine ID generated: ${machineId}`);
          try {
            machine = await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata, daemonState: initialDaemonState });
          } catch (retryError) {
            logger.warn(`[DAEMON RUN] Machine re-registration failed after machineId reset: ${retryError instanceof Error ? retryError.message : 'Unknown error'}`);
            machine = null;
            return false;
          }
        } else if (axios.isAxiosError(error) && error.response?.status === 401) {
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
    restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      try {
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
          onSessionDied: onHeartbeatPrunedSession,
          requestShutdown: (source, msg) => requestShutdown(source, msg),
          startupDiskVersion: diskVersion,
          fileState,
          controlPort,
          heartbeatIntervalHandle: restartOnStaleVersionAndHeartbeat!,
          teamHeartbeats,
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
      } catch (error) {
        logger.warn(
          '[DAEMON RUN] Heartbeat cycle failed; keeping daemon alive and retrying on the next interval',
          error instanceof Error ? error.stack || error.message : String(error)
        );
      } finally {
        heartbeatRunning = false;
      }
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

      await channelRouter.destroy();
      if (stopControlServer) {
        await stopControlServer();
      }
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Recover already-running sessions from previous daemon instance.
    // Pass api so recoverExistingSessions() can fetch the team roster and
    // filter out archived/archiveRequested members before re-tracking them.
    const recoveredCount = await recoverExistingSessions(api);
    if (recoveredCount > 0) {
      logger.debug(`[DAEMON RUN] Recovered ${recoveredCount} sessions from previous daemon instance`);
    }

    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    if (shutdownForceExitTimer) {
      clearTimeout(shutdownForceExitTimer);
      shutdownForceExitTimer = null;
    }
    if (restartOnStaleVersionAndHeartbeat) {
      clearInterval(restartOnStaleVersionAndHeartbeat);
    }
    if (stopControlServer) {
      await stopControlServer().catch((cleanupError) => {
        logger.debug('[DAEMON RUN][FATAL] Failed to stop control server during startup cleanup', cleanupError);
      });
    }
    if (channelRouter) {
      await channelRouter.destroy().catch((cleanupError) => {
        logger.debug('[DAEMON RUN][FATAL] Failed to destroy channel router during startup cleanup', cleanupError);
      });
    }
    await cleanupDaemonState().catch((cleanupError) => {
      logger.debug('[DAEMON RUN][FATAL] Failed to cleanup daemon state during startup cleanup', cleanupError);
    });
    if (caffeinateStarted) {
      await stopCaffeinate().catch((cleanupError) => {
        logger.debug('[DAEMON RUN][FATAL] Failed to stop caffeinate during startup cleanup', cleanupError);
      });
    }
    await releaseDaemonLock(daemonLockHandle).catch((cleanupError) => {
      logger.debug('[DAEMON RUN][FATAL] Failed to release daemon lock during startup cleanup', cleanupError);
    });
    process.exit(1);
  }
}
