/**
 * Cross-platform Aha CLI spawning utility
 *
 * ## Background
 *
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 *
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Aha.
 *
 * ## The Wrapper Strategy
 *
 * We created a wrapper script `bin/aha.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates
 * Windows-specific wrapper scripts (`aha.cmd` and `aha.ps1`) when it sees
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 *
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 *
 * ## Execution Chains
 *
 * **Unix/Linux/macOS:**
 * 1. User runs `aha` command
 * 2. Shell directly executes `bin/aha.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/aha.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 *
 * **Windows:**
 * 1. User runs `aha` command
 * 2. NPM wrapper (`aha.cmd`) calls `node bin/aha.mjs`
 * 3. `bin/aha.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 *
 * ## The Spawning Problem
 *
 * When our code needs to spawn Aha cli as a subprocess (for daemon processes),
 * we were trying to execute `bin/aha.mjs` directly. This fails on Windows
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 *
 * ## The Solution
 *
 * Since we know exactly what needs to happen (run `dist/index.mjs` with specific
 * Node.js flags), we can bypass all the wrapper layers and do it directly:
 *
 * `spawn(<preferred node binary>, ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 *
 * This works on all platforms and achieves the same result without any of the
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { withWindowsHide } from '@/utils/windowsProcessOptions';

/**
 * Spawn the Aha CLI with the given arguments in a cross-platform way.
 *
 * This function bypasses the wrapper script (bin/aha.mjs) and spawns the
 * actual CLI entrypoint (dist/index.mjs) directly with Node.js, ensuring
 * compatibility across all platforms including Windows.
 *
 * @param args - Arguments to pass to the Aha CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnAhaCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  const projectRoot = projectPath();
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');
  const sourceEntrypoint = join(projectRoot, 'src', 'index.ts');
  const tsxEntrypoint = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const allowSourceFallback = process.env.AHA_ALLOW_SOURCE_FALLBACK === '1';

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're actually executing a preferred Node runtime with the calculated
  // entrypoint path below, bypassing the 'aha' wrapper that would normally be found
  // in the shell's PATH.
  // However, we log it as 'aha' here because other engineers are typically looking
  // for when "aha" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `aha ${args.join(' ')}`;
  logger.debug(`[SPAWN AHA CLI] Spawning: ${fullCommand} in ${directory}`);

  let nodeArgs: string[];
  if (existsSync(entrypoint)) {
    nodeArgs = [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      ...args
    ];
  } else if (allowSourceFallback && existsSync(tsxEntrypoint) && existsSync(sourceEntrypoint)) {
    logger.debug(`[SPAWN AHA CLI] Explicit dev fallback enabled; running source via tsx: ${sourceEntrypoint}`);
    nodeArgs = [
      '--no-warnings',
      '--no-deprecation',
      tsxEntrypoint,
      sourceEntrypoint,
      ...args
    ];
  } else {
    const errorMessage = allowSourceFallback
      ? `Entrypoint ${entrypoint} does not exist`
      : `Entrypoint ${entrypoint} does not exist. This is a build invariant failure. Run 'cd ${projectRoot} && yarn build'. To intentionally use source fallback in dev, set AHA_ALLOW_SOURCE_FALLBACK=1.`;
    logger.debug(`[SPAWN AHA CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }

  const spawnOptions: SpawnOptions = withWindowsHide({ ...options });
  const nodeBinary = resolvePreferredNodeBinary(projectRoot);

  return spawn(nodeBinary, nodeArgs, spawnOptions);
}

function resolvePreferredNodeBinary(projectRoot: string): string {
  const requestedMajor = readPinnedNodeMajor(projectRoot);
  if (!requestedMajor) {
    return process.execPath;
  }

  const currentMajor = parseNodeMajor(process.versions.node);
  if (currentMajor === requestedMajor) {
    return process.execPath;
  }

  const pinnedBinary = findFnmNodeBinary(requestedMajor);
  if (pinnedBinary) {
    logger.debug(`[SPAWN AHA CLI] Using Node ${requestedMajor} from fnm: ${pinnedBinary}`);
    return pinnedBinary;
  }

  logger.debug(
    `[SPAWN AHA CLI] .node-version requests Node ${requestedMajor}, but no matching runtime was found. Falling back to ${process.execPath}`
  );
  return process.execPath;
}

function readPinnedNodeMajor(projectRoot: string): number | null {
  const nodeVersionFile = join(projectRoot, '.node-version');
  if (!existsSync(nodeVersionFile)) {
    return null;
  }

  try {
    return parseNodeMajor(readFileSync(nodeVersionFile, 'utf-8').trim());
  } catch {
    return null;
  }
}

function parseNodeMajor(version: string): number | null {
  const match = version.match(/^v?(\d+)/);
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

function findFnmNodeBinary(requestedMajor: number): string | null {
  for (const fnmRoot of getFnmRoots()) {
    const versionsDir = join(fnmRoot, 'node-versions');
    if (!existsSync(versionsDir)) {
      continue;
    }

    let versionDirs: string[] = [];
    try {
      versionDirs = readdirSync(versionsDir);
    } catch {
      continue;
    }

    const matchingVersions = versionDirs
      .map((dir) => ({ dir, version: parseSemverDir(dir) }))
      .filter((entry): entry is { dir: string; version: [number, number, number] } => {
        return entry.version !== null && entry.version[0] === requestedMajor;
      })
      .sort((a, b) => compareSemverDesc(a.version, b.version));

    for (const entry of matchingVersions) {
      const candidate = join(
        versionsDir,
        entry.dir,
        'installation',
        process.platform === 'win32' ? 'node.exe' : join('bin', 'node')
      );
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function getFnmRoots(): string[] {
  const roots = new Set<string>();

  if (process.env.FNM_DIR) {
    roots.add(process.env.FNM_DIR);
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      roots.add(join(process.env.LOCALAPPDATA, 'fnm'));
    }
    if (homeDir) {
      roots.add(join(homeDir, 'AppData', 'Local', 'fnm'));
    }
  } else if (homeDir) {
    roots.add(join(homeDir, '.local', 'share', 'fnm'));
    roots.add(join(homeDir, '.fnm'));
  }

  return Array.from(roots);
}

function parseSemverDir(dir: string): [number, number, number] | null {
  const match = dir.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) {
    return null;
  }

  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2] ?? '0', 10),
    Number.parseInt(match[3] ?? '0', 10),
  ];
}

function compareSemverDesc(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return b[1] - a[1];
  return b[2] - a[2];
}
