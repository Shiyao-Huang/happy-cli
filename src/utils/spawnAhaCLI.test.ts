import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockExistsSync, mockReadFileSync, mockReaddirSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(() => ({ pid: 1234 })),
  mockExistsSync: vi.fn(() => true),
  mockReadFileSync: vi.fn(),
  mockReaddirSync: vi.fn(() => []),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
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
  const currentNodeBinary = process.execPath;
  const currentNodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  const originalFnmDir = process.env.FNM_DIR;

  beforeEach(() => {
    mockSpawn.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockImplementation(((p: any) => p === '/tmp/aha-cli/dist/index.mjs') as any);
    mockReadFileSync.mockReset();
    mockReaddirSync.mockReset();
    delete process.env.FNM_DIR;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalFnmDir === undefined) {
      delete process.env.FNM_DIR;
    } else {
      process.env.FNM_DIR = originalFnmDir;
    }
  });

  it('hides spawned windows by default on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    spawnAhaCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      currentNodeBinary,
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
      currentNodeBinary,
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
      currentNodeBinary,
      expect.any(Array),
      expect.not.objectContaining({
        windowsHide: true,
      }),
    );
  });

  it('prefers the .node-version runtime from fnm when the current Node major differs', () => {
    const requestedMajor = currentNodeMajor + 1;
    process.env.FNM_DIR = '/tmp/fnm';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockImplementation(((p: any) => {
      return p === '/tmp/aha-cli/dist/index.mjs'
        || p === '/tmp/aha-cli/.node-version'
        || p === '/tmp/fnm/node-versions'
        || p === `/tmp/fnm/node-versions/v${requestedMajor}.9.1/installation/bin/node`;
    }) as any);
    mockReadFileSync.mockReturnValue(`${requestedMajor}\n`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddirSync.mockReturnValue([`v${requestedMajor}.1.0`, `v${requestedMajor}.9.1`] as any);

    spawnAhaCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      `/tmp/fnm/node-versions/v${requestedMajor}.9.1/installation/bin/node`,
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('falls back to the current runtime when no matching .node-version runtime is installed', () => {
    const requestedMajor = currentNodeMajor + 1;
    process.env.FNM_DIR = '/tmp/fnm';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockImplementation(((p: any) => {
      return p === '/tmp/aha-cli/dist/index.mjs'
        || p === '/tmp/aha-cli/.node-version'
        || p === '/tmp/fnm/node-versions';
    }) as any);
    mockReadFileSync.mockReturnValue(`${requestedMajor}\n`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddirSync.mockReturnValue([`v${requestedMajor}.1.0`] as any);

    spawnAhaCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      currentNodeBinary,
      expect.any(Array),
      expect.any(Object),
    );
  });
});
