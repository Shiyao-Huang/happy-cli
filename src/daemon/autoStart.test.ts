import { describe, expect, it, vi } from 'vitest';
import { ensureDaemonRunningForCommand, shouldAutoStartDaemon } from '@/daemon/autoStart';

describe('shouldAutoStartDaemon', () => {
  it('starts for regular commands', () => {
    expect(shouldAutoStartDaemon(['auth'], {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('skips daemon commands to avoid recursion', () => {
    expect(shouldAutoStartDaemon(['daemon'], {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('skips when AHA_NO_DAEMON=1', () => {
    expect(shouldAutoStartDaemon(['auth'], { AHA_NO_DAEMON: '1' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('ensureDaemonRunningForCommand', () => {
  it('starts daemon when not running', async () => {
    const deps = {
      isDaemonRunning: vi.fn().mockResolvedValue(false),
      spawnDaemon: vi.fn(),
      wait: vi.fn().mockResolvedValue(undefined),
      logDebug: vi.fn(),
    };

    const result = await ensureDaemonRunningForCommand(['auth'], {
      env: {} as NodeJS.ProcessEnv,
      deps,
      waitMs: 0
    });

    expect(result).toBe('started');
    expect(deps.isDaemonRunning).toHaveBeenCalledTimes(1);
    expect(deps.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(deps.logDebug).toHaveBeenCalledWith('daemon started automatically');
  });

  it('skips when AHA_NO_DAEMON is set', async () => {
    const deps = {
      isDaemonRunning: vi.fn(),
      spawnDaemon: vi.fn(),
      wait: vi.fn(),
      logDebug: vi.fn(),
    };

    const result = await ensureDaemonRunningForCommand(['auth'], {
      env: { AHA_NO_DAEMON: '1' } as NodeJS.ProcessEnv,
      deps
    });

    expect(result).toBe('skipped');
    expect(deps.isDaemonRunning).not.toHaveBeenCalled();
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
  });

  it('returns already-running when daemon version matches', async () => {
    const deps = {
      isDaemonRunning: vi.fn().mockResolvedValue(true),
      spawnDaemon: vi.fn(),
      wait: vi.fn(),
      logDebug: vi.fn(),
    };

    const result = await ensureDaemonRunningForCommand(['teams'], {
      env: {} as NodeJS.ProcessEnv,
      deps
    });

    expect(result).toBe('already-running');
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
  });

  it('returns failed if daemon spawn throws', async () => {
    const deps = {
      isDaemonRunning: vi.fn().mockResolvedValue(false),
      spawnDaemon: vi.fn().mockImplementation(() => {
        throw new Error('spawn failed');
      }),
      wait: vi.fn(),
      logDebug: vi.fn(),
    };

    const result = await ensureDaemonRunningForCommand(['roles'], {
      env: {} as NodeJS.ProcessEnv,
      deps
    });

    expect(result).toBe('failed');
    expect(deps.wait).not.toHaveBeenCalled();
  });
});
