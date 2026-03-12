import { isDaemonRunningCurrentlyInstalledAhaVersion } from '@/daemon/controlClient';
import { spawnAhaCLI } from '@/utils/spawnAhaCLI';
import { logger } from '@/ui/logger';

export type AutoStartResult = 'skipped' | 'already-running' | 'started' | 'failed';

type AutoStartDeps = {
  isDaemonRunning: () => Promise<boolean>;
  spawnDaemon: () => void;
  wait: (ms: number) => Promise<void>;
  logDebug: (message: string, ...args: unknown[]) => void;
};

const AUTO_START_WAIT_MS = 200;

function isAutoStartDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.AHA_NO_DAEMON?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function shouldAutoStartDaemon(args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const subcommand = args[0];

  if (!subcommand) {
    return false;
  }

  if (subcommand === 'daemon' || subcommand === '--help' || subcommand === '-h' || subcommand === '--version' || subcommand === '-v') {
    return false;
  }

  return !isAutoStartDisabled(env);
}

function defaultDeps(env: NodeJS.ProcessEnv): AutoStartDeps {
  return {
    isDaemonRunning: () => isDaemonRunningCurrentlyInstalledAhaVersion(),
    spawnDaemon: () => {
      const daemonProcess = spawnAhaCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env
      });
      daemonProcess.unref();
    },
    wait: async (ms: number) => {
      await new Promise<void>(resolve => setTimeout(resolve, ms));
    },
    logDebug: (message: string, ...args: unknown[]) => logger.debug(message, ...args),
  };
}

export async function ensureDaemonRunningForCommand(
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    deps?: Partial<AutoStartDeps>;
    waitMs?: number;
  }
): Promise<AutoStartResult> {
  const env = options?.env ?? process.env;
  if (!shouldAutoStartDaemon(args, env)) {
    if (isAutoStartDisabled(env)) {
      logger.debug('daemon auto-start skipped because AHA_NO_DAEMON is set');
    }
    return 'skipped';
  }

  const deps = {
    ...defaultDeps(env),
    ...options?.deps
  };

  deps.logDebug('Ensuring Aha background service is running & matches our version...');

  if (await deps.isDaemonRunning()) {
    deps.logDebug('Daemon is already running with matching CLI version');
    return 'already-running';
  }

  try {
    deps.spawnDaemon();
    await deps.wait(options?.waitMs ?? AUTO_START_WAIT_MS);
    deps.logDebug('daemon started automatically');
    return 'started';
  } catch (error) {
    deps.logDebug('Failed to start daemon automatically (non-fatal):', error);
    return 'failed';
  }
}
