import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import axios from 'axios';
// Note: packageJson import removed — all version reads now use disk package.json
// to prevent stale compiled versions from causing daemon restart loops.
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnAhaCLI } from '@/utils/spawnAhaCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledAhaVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { readSupervisorState, writeSupervisorState, updateSupervisorRun } from './supervisorState';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';

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
  let resolvesWhenShutdownRequested = new Promise<({ source: 'aha-app' | 'aha-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

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
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from aha session reporting itself
    const onAhaSessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.ahaSessionId = sessionId;
        existingSession.ahaSessionMetadataFromLocalWebhook = sessionMetadata;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'aha directly - likely by user from terminal',
          ahaSessionId: sessionId,
          ahaSessionMetadataFromLocalWebhook: sessionMetadata,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Resolve authentication token if provided
        let extraEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            extraEnv = {
              CODEX_HOME: codexHomeDir.name
            };
          } else { // Assuming claude
            extraEnv = {
              CLAUDE_CODE_OAUTH_TOKEN: options.token
            };
          }
        }

        // Add team context to environment if provided
        if (options.teamId) {
          extraEnv.AHA_ROOM_ID = options.teamId;
          logger.debug(`[DAEMON RUN] Setting AHA_ROOM_ID=${options.teamId}`);
        }
        if (options.role) {
          extraEnv.AHA_AGENT_ROLE = options.role;
          logger.debug(`[DAEMON RUN] Setting AHA_AGENT_ROLE=${options.role}`);
        }
        if (options.sessionName) {
          extraEnv.AHA_SESSION_NAME = options.sessionName;
          logger.debug(`[DAEMON RUN] Setting AHA_SESSION_NAME=${options.sessionName}`);
        }
        if (options.sessionPath) {
          extraEnv.AHA_SESSION_PATH = options.sessionPath;
          logger.debug(`[DAEMON RUN] Setting AHA_SESSION_PATH=${options.sessionPath}`);
        }
        if (options.parentSessionId) {
          extraEnv.AHA_PARENT_SESSION_ID = options.parentSessionId;
          logger.debug(`[DAEMON RUN] Setting AHA_PARENT_SESSION_ID=${options.parentSessionId}`);
        }
        if (options.specId) {
          extraEnv.AHA_SPEC_ID = options.specId;
          logger.debug(`[DAEMON RUN] Setting AHA_SPEC_ID=${options.specId}`);
        }
        if (options.executionPlane) {
          extraEnv.AHA_EXECUTION_PLANE = options.executionPlane;
          logger.debug(`[DAEMON RUN] Setting AHA_EXECUTION_PLANE=${options.executionPlane}`);
        }

        // Merge custom env variables (e.g., AHA_AGENT_LANGUAGE)
        if (options.env) {
          Object.assign(extraEnv, options.env);
          logger.debug(`[DAEMON RUN] Merging custom env: ${JSON.stringify(options.env)}`);
        }

        // Construct arguments for the CLI based on agent type
        let args: string[];
        if (options.agent === 'ralph') {
          // Ralph loop runs as a standalone process
          args = [
            'ralph', 'start',
            '--prd', options.prdPath || join(directory, 'prd.json'),
            '--max-iterations', String(options.maxIterations || 10),
            '--started-by', 'daemon',
          ];
        } else {
          args = [
            options.agent === 'claude' ? 'claude' : 'codex',
            '--aha-starting-mode', 'remote',
            '--started-by', 'daemon',
          ];
        }

        if (options.sessionTag) {
          args.push('--session-tag', options.sessionTag);
        }

        // TODO: In future, sessionId could be used with --resume to continue existing sessions
        // For now, we ignore it - each spawn creates a new session
        // Build env: inherit parent but unset CLAUDECODE to prevent nested session detection
        const { CLAUDECODE: _, ...cleanEnv } = process.env;
        const ahaProcess = spawnAhaCLI(args, {
          cwd: directory,
          detached: true,  // Sessions stay alive when daemon stops
          stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
          env: {
            ...cleanEnv,
            ...extraEnv
          }
        });

        // Log output for debugging
        if (process.env.DEBUG) {
          ahaProcess.stdout?.on('data', (data) => {
            logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
          });
          ahaProcess.stderr?.on('data', (data) => {
            logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
          });
        }

        if (!ahaProcess.pid) {
          logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
          return {
            type: 'error',
            errorMessage: 'Failed to spawn Aha process - no PID returned'
          };
        }

        logger.debug(`[DAEMON RUN] Spawned process with PID ${ahaProcess.pid}`);

        // Notify caller immediately — before waiting for webhook — so callers
        // that need to persist the PID (e.g. supervisor singleton guard) can do
        // so without relying on the webhook arriving within the timeout window.
        options.onPidKnown?.(ahaProcess.pid);

        const trackedSession: TrackedSession = {
          startedBy: 'daemon',
          pid: ahaProcess.pid,
          childProcess: ahaProcess,
          directoryCreated,
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
        };

        pidToTrackedSession.set(ahaProcess.pid, trackedSession);

        ahaProcess.on('exit', (code, signal) => {
          logger.debug(`[DAEMON RUN] Child PID ${ahaProcess.pid} exited with code ${code}, signal ${signal}`);
          if (ahaProcess.pid) {
            onChildExited(ahaProcess.pid);
          }
        });

        ahaProcess.on('error', (error) => {
          logger.debug(`[DAEMON RUN] Child process error:`, error);
          if (ahaProcess.pid) {
            onChildExited(ahaProcess.pid);
          }
        });

        // Wait for webhook to populate session with ahaSessionId
        logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${ahaProcess.pid}`);

        return new Promise((resolve) => {
          // Set timeout for webhook
          const timeout = setTimeout(() => {
            pidToAwaiter.delete(ahaProcess.pid!);
            logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${ahaProcess.pid}`);
            resolve({
              type: 'error',
              errorMessage: `Session webhook timeout for PID ${ahaProcess.pid}`
            });
            // 15 second timeout - I have seen timeouts on 10 seconds
            // even though session was still created successfully in ~2 more seconds
          }, 15_000);

          // Register awaiter
          pidToAwaiter.set(ahaProcess.pid!, (completedSession) => {
            clearTimeout(timeout);
            logger.debug(`[DAEMON RUN] Session ${completedSession.ahaSessionId} fully spawned with webhook`);
            resolve({
              type: 'success',
              sessionId: completedSession.ahaSessionId!
            });
          });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.ahaSessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              session.childProcess.kill('SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          pidToTrackedSession.delete(pid);
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Stop all sessions belonging to a team
    const stopTeamSessions = (teamId: string): { stopped: number; errors: string[] } => {
      logger.debug(`[DAEMON RUN] Attempting to stop all sessions for team ${teamId}`);

      const errors: string[] = [];
      let stopped = 0;

      for (const [pid, session] of pidToTrackedSession.entries()) {
        const metadata = session.ahaSessionMetadataFromLocalWebhook;
        const sessionTeamId = metadata?.teamId || metadata?.roomId;

        if (sessionTeamId === teamId) {
          const sessionId = session.ahaSessionId || `PID-${pid}`;
          logger.debug(`[DAEMON RUN] Stopping team session ${sessionId} (PID: ${pid})`);

          try {
            if (session.startedBy === 'daemon' && session.childProcess) {
              session.childProcess.kill('SIGTERM');
            } else {
              process.kill(pid, 'SIGTERM');
            }
            pidToTrackedSession.delete(pid);
            stopped++;
            logger.debug(`[DAEMON RUN] Stopped team session ${sessionId}`);
          } catch (error) {
            const errorMsg = `Failed to stop session ${sessionId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
            logger.debug(`[DAEMON RUN] ${errorMsg}`);
            errors.push(errorMsg);
          }
        }
      }

      logger.debug(`[DAEMON RUN] Stopped ${stopped} sessions for team ${teamId}, errors: ${errors.length}`);
      return { stopped, errors };
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      pidToTrackedSession.delete(pid);
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      stopTeamSessions,
      spawnSession,
      requestShutdown: () => requestShutdown('aha-cli'),
      onAhaSessionWebhook,
      onClaudeLocalSessionFound: (ahaSessionId, claudeLocalSessionId) => {
        // Map from ahaSessionId back to pid, then store the local Claude session file ID
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
    // The compiled `packageJson.version` can be stale if package.json was bumped
    // without rebuilding dist/. Reading from disk ensures the version written to
    // daemon.state.json matches what isDaemonRunningCurrentlyInstalledAhaVersion() reads.
    const diskVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;

    // Write initial daemon state (no lock needed for state file)
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
    const api = await ApiClient.create(credentials);

    /** Resolve the specId of a @official genome by name.
     *  Queries genome-hub first (M3 marketplace), falls back to happy-server (M2 legacy).
     *  Returns null on failure — caller falls back to hardcoded role. */
    const resolveSystemGenomeId = async (name: string): Promise<string | null> => {
      // Primary: genome-hub (M3 marketplace)
      const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
      try {
        const res = await axios.get(
          `${hubUrl}/genomes/%40official/${name}`,
          { timeout: 5000 }
        );
        const id = res.data?.genome?.id ?? null;
        if (id) return id;
      } catch { /* fall through */ }

      // Fallback: happy-server (M2 legacy)
      try {
        const res = await axios.get(
          `${configuration.serverUrl}/v1/genomes/%40official/${name}/latest`,
          { headers: { Authorization: `Bearer ${credentials.token}` }, timeout: 5000 }
        );
        return res.data?.genome?.id ?? null;
      } catch {
        return null;
      }
    };

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('aha-app')
    });

    // Connect to server
    apiMachine.connect();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.AHA_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    let heartbeatCount = 0;
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
        }
      }

      // Supervisor check: every N heartbeats, spawn a supervisor agent if there are active team sessions
      heartbeatCount++;
      const supervisorInterval = parseInt(process.env.AHA_SUPERVISOR_INTERVAL || '20'); // Every 20 heartbeats = 20 minutes
      if (heartbeatCount % supervisorInterval === 0 && pidToTrackedSession.size > 0) {
        // Collect all unique teamIds with active non-bypass sessions
        const activeTeamIds = new Set<string>();
        for (const [_, session] of pidToTrackedSession.entries()) {
          const meta = session.ahaSessionMetadataFromLocalWebhook;
          const sessionTeamId = meta?.teamId || meta?.roomId;
          if (!sessionTeamId) continue;
          if (meta?.role === 'supervisor' || meta?.role === 'help-agent') continue;
          activeTeamIds.add(sessionTeamId);
        }

        for (const teamId of activeTeamIds) {
          // Skip if team is marked as terminated
          const supervisorState = readSupervisorState(teamId);
          if (supervisorState.terminated) {
            logger.debug(`[DAEMON RUN] Skipping supervisor for terminated team ${teamId}`);
            continue;
          }

          // ── Singleton guard ────────────────────────────────────────────────
          // Use the persisted PID to detect a running supervisor even across
          // daemon restarts (supervisors are spawned detached and outlive the
          // daemon process that created them).
          if (supervisorState.lastSupervisorPid > 0) {
            try {
              process.kill(supervisorState.lastSupervisorPid, 0); // signal 0 = liveness check, no-op
              logger.debug(`[DAEMON RUN] Supervisor already running (PID ${supervisorState.lastSupervisorPid}) for team ${teamId}, skipping`);
              continue;
            } catch {
              // ESRCH: process not found — previous supervisor has exited, safe to spawn
              logger.debug(`[DAEMON RUN] Previous supervisor PID ${supervisorState.lastSupervisorPid} is gone for team ${teamId}, will spawn new one`);
            }
          }
          // ──────────────────────────────────────────────────────────────────

          // Auto-retire if too many idle runs (no new content found N times in a row)
          const maxIdleRuns = parseInt(process.env.AHA_SUPERVISOR_MAX_IDLE || '6'); // 6 × 5 min = 30 min
          if (supervisorState.idleRuns >= maxIdleRuns) {
            logger.debug(`[DAEMON RUN] Supervisor idle for ${supervisorState.idleRuns} runs on team ${teamId}, marking terminated`);
            writeSupervisorState({ ...supervisorState, terminated: true });
            continue;
          }

          logger.debug(`[DAEMON RUN] Supervisor check triggered (heartbeat #${heartbeatCount}, team ${teamId}, cursor=${supervisorState.teamLogCursor})`);

          // If the state hasn't been updated since last heartbeat trigger, the previous
          // supervisor found nothing new and didn't call save_supervisor_state → idle run
          const heartbeatMs = heartbeatIntervalMs * supervisorInterval;
          const stateIsStale = supervisorState.lastRunAt > 0 && (Date.now() - supervisorState.lastRunAt) > heartbeatMs * 1.5;
          if (stateIsStale) {
            updateSupervisorRun(teamId, { idleRuns: supervisorState.idleRuns + 1 });
            logger.debug(`[DAEMON RUN] Supervisor idle run detected for team ${teamId}, idleRuns now ${supervisorState.idleRuns + 1}`);
          }

          try {
            // Resolve @official/supervisor genome specId from genome-hub.
            // In testing phase: log a visible warning when genome DNA is missing so we can fix it.
            const supervisorSpecId = await resolveSystemGenomeId('supervisor');
            if (!supervisorSpecId) {
                if (process.env.AHA_GENOME_FALLBACK !== '1') {
                    console.warn(
                        `[GENOME] ⚠️  supervisor genome not found in genome-hub — spawning without DNA.\n` +
                        `         Ensure genome-hub is running (GENOME_HUB_URL=${process.env.GENOME_HUB_URL ?? 'http://localhost:3006'})\n` +
                        `         and @official/supervisor is seeded. (Set AHA_GENOME_FALLBACK=1 to silence.)`
                    );
                }
            } else {
                logger.debug(`[DAEMON RUN] Supervisor genome specId: ${supervisorSpecId}`);
            }

            const supervisorResult = await spawnSession({
              directory: process.cwd(),
              agent: 'claude',
              teamId,
              role: 'supervisor',
              sessionName: 'Supervisor',
              executionPlane: 'bypass',
              specId: supervisorSpecId ?? undefined,
              env: {
                // Pass state so supervisor reads only new content
                AHA_SUPERVISOR_TEAM_LOG_CURSOR: String(supervisorState.teamLogCursor),
                AHA_SUPERVISOR_CC_LOG_CURSORS: JSON.stringify(supervisorState.ccLogCursors),
                AHA_SUPERVISOR_LAST_CONCLUSION: supervisorState.lastConclusion,
                AHA_SUPERVISOR_LAST_SESSION_ID: supervisorState.lastSessionId || '',
                AHA_SUPERVISOR_PENDING_ACTION: supervisorState.pendingAction
                    ? JSON.stringify(supervisorState.pendingAction)
                    : '',
              },
              // Persist PID immediately on fork — before the webhook arrives — so
              // the singleton guard works even if the webhook times out or the
              // daemon restarts during the 15-second webhook wait window.
              onPidKnown: (pid) => {
                updateSupervisorRun(teamId, { lastSupervisorPid: pid });
                logger.debug(`[DAEMON RUN] Persisted supervisor PID ${pid} for team ${teamId} (pre-webhook)`);
              },
            });
            if (supervisorResult.type === 'success') {
              logger.debug(`[DAEMON RUN] Supervisor agent spawned: ${supervisorResult.sessionId}`);
            }
          } catch (e) {
            logger.debug(`[DAEMON RUN] Failed to spawn supervisor: ${e}`);
          }
        }
      }

      // Check if daemon needs update by comparing current disk version with
      // the version we recorded at startup. This detects real npm upgrades
      // (where the dist/ files AND package.json both change on disk).
      // Previous implementation compared disk vs compiled version, which broke
      // when package.json was bumped without rebuilding — causing infinite restart loops.
      const currentDiskVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
      if (currentDiskVersion !== diskVersion) {
        // Cooldown: don't restart if daemon started less than 2 minutes ago
        const uptimeMs = Date.now() - new Date(fileState.startTime).getTime();
        if (uptimeMs < 120_000) {
          logger.debug(`[DAEMON RUN] Version changed on disk (${diskVersion} → ${currentDiskVersion}) but daemon uptime is only ${Math.round(uptimeMs / 1000)}s — skipping restart to avoid loop`);
        } else {
          logger.debug(`[DAEMON RUN] Version changed on disk (${diskVersion} → ${currentDiskVersion}), triggering self-restart`);

          clearInterval(restartOnStaleVersionAndHeartbeat);

          try {
            spawnAhaCLI(['daemon', 'start'], {
              detached: true,
              stdio: 'ignore'
            });
          } catch (error) {
            logger.debug('[DAEMON RUN] Failed to spawn new daemon', error);
          }

          logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us');
          await new Promise(resolve => setTimeout(resolve, 10_000));
          process.exit(0);
        }
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: diskVersion,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'aha-app' | 'aha-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
