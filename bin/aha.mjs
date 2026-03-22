#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

// Minimum supported Node version
const MIN_NODE_MAJOR = 20;
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < MIN_NODE_MAJOR) {
  console.error(`aha-v3 requires Node.js >= ${MIN_NODE_MAJOR}.0.0 (current: ${process.versions.node})`);
  console.error('Install Node 22 via fnm: fnm install 22 && fnm use 22 && npm install -g cc-aha-cli-v3');
  process.exit(1);
}

// Check if we're already running with the flags
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

if (!hasNoWarnings || !hasNoDeprecation) {
  // Get path to the actual CLI entrypoint
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');

  // Verify entrypoint exists before spawning
  if (!existsSync(entrypoint)) {
    console.error(`aha-v3: dist/index.mjs not found at ${entrypoint}`);
    console.error('The package may be corrupted. Try reinstalling:');
    console.error('  npm install -g cc-aha-cli-v3@latest');
    process.exit(1);
  }

  // Execute the actual CLI directly with the correct flags
  try {
    execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      ...process.argv.slice(2)
    ], {
      stdio: 'inherit',
      env: process.env
    });
  } catch (error) {
    // execFileSync throws if the process exits with non-zero
    process.exit(error.status || 1);
  }
} else {
  // We're running Node with the flags we wanted, import the CLI entrypoint
  // module to avoid creating a new process.
  import("../dist/index.mjs");
}
