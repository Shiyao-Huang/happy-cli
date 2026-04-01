import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockExistsSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(() => ({ pid: 1234 })),
  mockExistsSync: vi.fn(() => true),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('@/projectPath', () => ({
  projectPath: () => '/tmp/aha-cli',
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import { spawnAhaCLI } from '@/utils/spawnAhaCLI';

describe('spawnAhaCLI', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockSpawn.mockClear();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('hides spawned windows by default on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    spawnAhaCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      [
        '--no-warnings',
        '--no-deprecation',
        '/tmp/aha-cli/dist/index.mjs',
        'daemon',
        'start-sync',
      ],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
  });

  it('preserves an explicit windowsHide override', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    spawnAhaCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      expect.any(Array),
      expect.objectContaining({
        windowsHide: false,
      }),
    );
  });

  it('does not inject windowsHide on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    spawnAhaCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      expect.any(Array),
      expect.not.objectContaining({
        windowsHide: true,
      }),
    );
  });
});
