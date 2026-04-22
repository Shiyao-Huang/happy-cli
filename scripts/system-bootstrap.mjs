#!/usr/bin/env node

/**
 * @fileoverview System Bootstrap — Complete self-starting entrypoint
 *
 * Ensures the entire Aha system is running:
 *   1. Resolve correct aha-agi version (via bootstrapper)
 *   2. Ensure daemon is running
 *   3. Ensure team sessions are active
 *   4. Monitor and auto-restart on failure
 *
 * Usage:
 *   node scripts/system-bootstrap.mjs           # Start everything
 *   node scripts/system-bootstrap.mjs --monitor # Start + monitor loop
 */

import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// ── Logging ──────────────────────────────────────────────────────────────────

function log(message) {
  console.log(`[system-bootstrap] ${message}`);
}

function logError(message) {
  console.error(`[system-bootstrap:error] ${message}`);
}

// ── Resolve entrypoint ───────────────────────────────────────────────────────

async function resolveEntrypoint() {
  const bootstrapperPath = join(projectRoot, 'bin', 'bootstrapper.mjs');
  if (existsSync(bootstrapperPath)) {
    try {
      const { resolveEntrypoint: bpResolve } = await import(bootstrapperPath);
      const entrypoint = await bpResolve();
      if (entrypoint && existsSync(entrypoint)) {
        return entrypoint;
      }
    } catch (error) {
      logError(`Bootstrapper failed: ${error.message}`);
    }
  }
  // Fallback
  const bundled = join(projectRoot, 'dist', 'index.mjs');
  return bundled;
}

// ── Daemon checks ────────────────────────────────────────────────────────────

function isDaemonRunning() {
  try {
    const ahaHome = process.env.AHA_HOME_DIR || join(process.env.HOME, '.aha');
    const statePath = join(ahaHome, 'daemon.state.json');
    if (!existsSync(statePath)) return false;

    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (!state.pid) return false;

    try {
      process.kill(state.pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function startDaemon(entrypoint) {
  log('Starting daemon...');
  const child = spawn(process.execPath, [
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    'daemon',
    'start-sync',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for daemon state file
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (isDaemonRunning()) {
      log('Daemon started successfully');
      return true;
    }
    // Check if process died
    try {
      process.kill(child.pid, 0);
    } catch {
      logError('Daemon process died during startup');
      return false;
    }
  }

  logError('Daemon did not become ready within timeout');
  return false;
}

// ── Session checks ───────────────────────────────────────────────────────────

function listDaemonSessions() {
  try {
    const ahaHome = process.env.AHA_HOME_DIR || join(process.env.HOME, '.aha');
    const statePath = join(ahaHome, 'daemon.state.json');
    if (!existsSync(statePath)) return [];

    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (!state.httpPort) return [];

    const result = execSync(
      `curl -s -X POST http://127.0.0.1:${state.httpPort}/list`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const json = JSON.parse(result);
    return json.children || [];
  } catch {
    return [];
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const monitor = args.includes('--monitor');

  log('=== Aha System Bootstrap ===');

  // Step 1: Resolve entrypoint
  const entrypoint = await resolveEntrypoint();
  log(`Entrypoint: ${entrypoint}`);

  // Step 2: Ensure daemon is running
  if (!isDaemonRunning()) {
    log('Daemon not running, starting...');
    const started = await startDaemon(entrypoint);
    if (!started) {
      logError('Failed to start daemon');
      process.exit(1);
    }
  } else {
    log('Daemon is already running');
  }

  // Step 3: Check sessions
  const sessions = listDaemonSessions();
  log(`Active sessions: ${sessions.length}`);
  for (const s of sessions) {
    log(`  - PID ${s.pid}: ${s.startedBy || 'unknown'}`);
  }

  // Step 4: Monitor mode
  if (monitor) {
    log('Monitor mode: watching daemon health...');
    setInterval(async () => {
      if (!isDaemonRunning()) {
        logError('Daemon died! Restarting...');
        const ep = await resolveEntrypoint();
        await startDaemon(ep);
      }
    }, 30000); // Check every 30s
  }

  log('=== Bootstrap complete ===');
}

main().catch(error => {
  logError(`Fatal: ${error.message}`);
  process.exit(1);
});
