#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// ── Node version check ───────────────────────────────────────────────────────

const MIN_NODE_MAJOR = 20;
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < MIN_NODE_MAJOR) {
  console.error(`aha requires Node.js >= ${MIN_NODE_MAJOR}.0.0 (current: ${process.versions.node})`);
  console.error('Install Node 22 via fnm: fnm install 22 && fnm use 22 && npm install -g aha-agi');
  process.exit(1);
}

// ── Bootstrapper: resolve correct main entrypoint ────────────────────────────
// The bootstrapper manages version updates independently of the main package.
// When aha-agi updates, only the main package changes; this bootstrapper stays the same.

async function resolveEntrypoint() {
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const bootstrapperPath = join(projectRoot, 'bin', 'bootstrapper.mjs');

  // If bootstrapper exists, use it for version management
  if (existsSync(bootstrapperPath)) {
    try {
      const { resolveEntrypoint: bootstrapperResolve } = await import(bootstrapperPath);
      const entrypoint = await bootstrapperResolve();
      if (entrypoint && existsSync(entrypoint)) {
        return entrypoint;
      }
    } catch (error) {
      // Bootstrapper failed; fall through to bundled entrypoint
      if (process.env.AHA_BOOTSTRAPPER_DEBUG) {
        console.error('[bootstrapper] Version resolution failed, using bundled:', error.message);
      }
    }
  }

  // Fallback to bundled entrypoint
  const bundledEntrypoint = join(projectRoot, 'dist', 'index.mjs');
  return bundledEntrypoint;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const entrypoint = await resolveEntrypoint();

  if (!existsSync(entrypoint)) {
    console.error(`aha: entrypoint not found at ${entrypoint}`);
    console.error('The package may be corrupted. Try reinstalling:');
    console.error('  npm install -g aha-agi@latest');
    process.exit(1);
  }

  // Check if we're already running with the flags
  const hasNoWarnings = process.execArgv.includes('--no-warnings');
  const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

  if (!hasNoWarnings || !hasNoDeprecation) {
    // Execute the actual CLI directly with the correct flags
    try {
      execFileSync(process.execPath, [
        '--no-warnings',
        '--no-deprecation',
        entrypoint,
        ...process.argv.slice(2)
      ], {
        stdio: 'inherit',
        env: process.env,
        windowsHide: process.platform === 'win32'
      });
    } catch (error) {
      // execFileSync throws if the process exits with non-zero
      process.exit(error.status || 1);
    }
  } else {
    // We're running Node with the flags we wanted, import the CLI entrypoint
    // module to avoid creating a new process.
    await import(entrypoint);
  }
}

main().catch((error) => {
  console.error('aha: unexpected error:', error);
  process.exit(1);
});
