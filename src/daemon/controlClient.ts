/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState, readDaemonStateRaw } from '@/persistence';
import { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';
import { spawnAhaCLI } from '@/utils/spawnAhaCLI';
import { stripSessionScopedAhaEnv } from '@/utils/sessionScopedAhaEnv';

export async function daemonPost(path: string, body?: any): Promise<{ error?: string } | any> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = process.env.AHA_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.AHA_DAEMON_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage
      };
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<{ error?: string } | any> {
  return await daemonPost('/session-started', {
    sessionId,
    metadata
  });
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function stopDaemonTeamSessions(teamId: string): Promise<{ success: boolean; stopped: number; errors: string[] }> {
  const result = await daemonPost('/stop-team-sessions', { teamId });
  return {
    success: result.success || false,
    stopped: result.stopped || 0,
    errors: result.errors || []
  };
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId });
  return result;
}

export async function stopDaemonHttp(): Promise<void> {
  await daemonPost('/stop');
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded aha,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 *
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 *
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure
 * our daemon is always alive and running the latest version.
 *
 * That seems like an overkill and yet another process to manage - lets not do this :D
 *
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 *
 * We can destructure the response on the caller for richer output.
 * For instance when running `aha daemon status` we can show more information.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    await cleanupOrphanedDaemonLock();
    return false;
  }

  // Check if the daemon is running
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
    return false;
  }
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonLockPid(): number | null {
  try {
    const pid = Number(readFileSync(configuration.daemonLockFile, 'utf-8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function cleanupOrphanedDaemonLock(): Promise<void> {
  const rawState = await readDaemonStateRaw();
  if (rawState && rawState.state !== 'stopped') {
    return;
  }

  const lockPid = readDaemonLockPid();
  if (!lockPid) {
    return;
  }

  if (!(await isPidRunning(lockPid))) {
    logger.debug('[DAEMON RUN] Lock file points to a dead PID, cleaning up stale daemon metadata');
    await cleanupDaemonState();
    return;
  }

  logger.debug(`[DAEMON RUN] Found orphaned daemon lock held by PID ${lockPid}, terminating it`);

  try {
    process.kill(lockPid, 'SIGTERM');
  } catch {
    // Ignore races if the process exits between the existence check and SIGTERM.
  }

  await waitForProcessDeath(lockPid, 1500).catch(() => { });

  if (await isPidRunning(lockPid)) {
    try {
      process.kill(lockPid, 'SIGKILL');
    } catch {
      // Ignore races if the process exits before the hard kill.
    }
    await waitForProcessDeath(lockPid, 1500).catch(() => { });
  }

  if (await isPidRunning(lockPid)) {
    throw new Error(`Failed to clear stale daemon lock held by PID ${lockPid}`);
  }

  await cleanupDaemonState();
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 *
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledAhaVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }

  try {
    // Read package.json on demand from disk - so we are guaranteed to get the latest version
    const packageJsonPath = join(projectPath(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const currentCliVersion = packageJson.version;

    logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
    return currentCliVersion === state.startedWithCliVersion;

    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // Kirill does not understand how the upgrade of npm packages happen and whether
    // we will get a new path or not when aha-coder is upgraded globally.
    // If reading package.json doesn't work correctly after npm upgrades,
    // we can revert to spawning a process (but should add timeout and cleanup!)
    /*
    const { spawnAhaCLI } = await import('@/utils/spawnAhaCLI');
    const ahaProcess = spawnAhaCLI(['--version'], { stdio: 'pipe' });
    let version: string | null = null;
    ahaProcess.stdout?.on('data', (data) => {
      version = data.toString().trim();
    });
    await new Promise(resolve => ahaProcess.stdout?.on('close', resolve));
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${version}, Daemon started with version: ${state.startedWithCliVersion}`);
    return version === state.startedWithCliVersion;
    */
  } catch (error) {
    logger.debug('[DAEMON CONTROL] Error checking daemon version', error);
    return false;
  }
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function startDaemonDetached(): Promise<boolean> {
  const child = spawnAhaCLI(['daemon', 'start-sync'], {
    detached: true,
    stdio: 'ignore',
    env: stripSessionScopedAhaEnv(process.env, { stripClaudeCode: true })
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    const state = await readDaemonState();
    if (state?.pid && state.httpPort) {
      try {
        process.kill(state.pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    if (child.pid && !(await isPidRunning(child.pid))) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return false;
}

export async function ensureDaemonRunning(): Promise<'already-running' | 'started'> {
  const runningCurrentVersion = await isDaemonRunningCurrentlyInstalledAhaVersion();
  if (runningCurrentVersion) {
    return 'already-running';
  }

  await cleanupOrphanedDaemonLock();

  let started = await startDaemonDetached();
  if (!started) {
    await cleanupOrphanedDaemonLock();
    started = await startDaemonDetached();
  }

  if (!started) {
    throw new Error('Failed to start daemon');
  }

  return 'started';
}

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      await cleanupDaemonState();
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    } finally {
      await cleanupDaemonState();
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}
