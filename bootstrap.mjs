#!/usr/bin/env node
/**
 * AHA Bootstrap Operator
 *
 * Stable outer control plane for daemon restarts.
 * Contract:
 * - daemon state file: pid/httpPort/version/buildHash
 * - GET /health
 * - GET /version
 * - bootstrap lock file
 *
 * This file intentionally uses Node built-ins only and does not import dist/*.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AHA_HOME = process.env.AHA_HOME_DIR || join(homedir(), '.aha');
const CONFIG_PATH = join(ROOT, 'bootstrap-config.json');
const DEFAULT_STATE_FILE = join(DEFAULT_AHA_HOME, 'daemon.state.json');
const DEFAULT_CREDENTIALS_FILE = join(DEFAULT_AHA_HOME, 'access.key');
const DEFAULT_LOCK_FILE = join(ROOT, '.bootstrap.lock');
const DEFAULT_HANDOFF_FILE = join(ROOT, '.aha', 'bootstrap-handoff.json');
const DEFAULT_DAEMON_CMD = ['node', 'dist/index.mjs', 'daemon', 'start-sync'];
const DEFAULT_SERVER_URL = process.env.AHA_SERVER_URL || 'https://aha-agi.com/api';
const MAX_WAIT_SECONDS = 30;

const cmd = process.argv[2] ?? 'restart';

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const config = loadConfig();
const STATE_FILE = config.stateFile || DEFAULT_STATE_FILE;
const CREDENTIALS_FILE = config.credentialsFile || DEFAULT_CREDENTIALS_FILE;
const LOCK_FILE = config.lockFile || DEFAULT_LOCK_FILE;
const HANDOFF_FILE = config.handoffFile || DEFAULT_HANDOFF_FILE;
const DAEMON_CMD = Array.isArray(config.daemonCommand) && config.daemonCommand.length > 0
  ? config.daemonCommand
  : DEFAULT_DAEMON_CMD;

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function baseUrl() {
  const state = readState();
  const port = state?.httpPort || config.daemonPort || 3000;
  return `http://127.0.0.1:${port}`;
}

async function fetchJson(pathname) {
  try {
    const response = await fetch(`${baseUrl()}${pathname}`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) return await response.json();
  } catch {}
  return null;
}

async function checkHealth() {
  return fetchJson('/health');
}

async function checkVersion() {
  return fetchJson('/version');
}

function readPid() {
  return readState()?.pid ?? null;
}

function killOld() {
  const pid = readPid();
  if (!pid) {
    try { execSync('pkill -f "dist/index.mjs daemon start-sync" 2>/dev/null || true'); } catch {}
    // Also clean up any orphaned agent session processes from a prior build
    try { execSync('pkill -f "dist/index.mjs" 2>/dev/null || true'); } catch {}
    return null;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[bootstrap] Sent SIGTERM to old daemon PID ${pid}`);
    // Also kill any orphaned agent session processes still referencing old dist chunks
    try { execSync('pkill -f "dist/index.mjs" 2>/dev/null || true'); } catch {}
    return pid;
  } catch (error) {
    console.log(`[bootstrap] PID ${pid} already gone: ${error.message}`);
    return null;
  }
}

async function waitDead(oldPid, maxMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    try {
      process.kill(oldPid, 0);
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function startNew() {
  const child = spawn(DAEMON_CMD[0], DAEMON_CMD.slice(1), {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`[bootstrap] Started new daemon PID ${child.pid}`);
  return child.pid;
}

async function waitReady(oldPid, oldBuildHash) {
  for (let attempt = 0; attempt < MAX_WAIT_SECONDS; attempt++) {
    // Try /version first (new contract), fall back to /health (old contract)
    const version = await checkVersion();
    if (version?.ok) {
      const pidChanged = oldPid == null || version.pid !== oldPid;
      const buildChanged = oldBuildHash == null || version.buildHash !== oldBuildHash;
      if (pidChanged && buildChanged) {
        console.log(`[bootstrap] Daemon ready on new build: ${JSON.stringify(version)}`);
        return version;
      }
    } else {
      // Fallback: old daemon without /version — check PID change via state file
      const state = readState();
      const health = await checkHealth();
      if (health && state?.pid && state.pid !== oldPid) {
        console.log(`[bootstrap] Daemon ready (legacy health check, no buildHash): PID ${state.pid}`);
        return { ok: true, pid: state.pid, port: state.httpPort, buildHash: null };
      }
    }
    process.stdout.write('.');
    await sleep(1000);
  }

  console.log('\n[bootstrap] WARNING: daemon did not report ready in time');
  return null;
}

function acquireLock() {
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch {}
}

function writeHandoff(payload) {
  mkdirSync(dirname(HANDOFF_FILE), { recursive: true });
  writeFileSync(HANDOFF_FILE, JSON.stringify(payload, null, 2));
}

function readToken() {
  try {
    const credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
    return typeof credentials?.token === 'string' ? credentials.token : null;
  } catch {
    return null;
  }
}

async function sendTeamHandoff(payload) {
  const teamId = config.teamId || process.env.AHA_ROOM_ID || null;
  const token = config.token || readToken();
  if (!teamId || !token) return false;

  try {
    const response = await fetch(`${config.serverUrl || DEFAULT_SERVER_URL}/v1/teams/${teamId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: `bootstrap-${Date.now()}`,
        teamId,
        type: 'chat',
        timestamp: Date.now(),
        fromSessionId: 'bootstrap-operator',
        fromRole: 'bootstrap-operator',
        content: `Bootstrap restart complete: PID ${payload.oldPid ?? 'unknown'} -> ${payload.newPid}, build ${payload.oldBuildHash ?? 'unknown'} -> ${payload.newBuildHash ?? 'unknown'}.`,
        metadata: {
          type: 'bootstrap-handoff',
          oldPid: payload.oldPid ?? null,
          newPid: payload.newPid,
          oldBuildHash: payload.oldBuildHash ?? null,
          newBuildHash: payload.newBuildHash ?? null,
          runtimeEntrypoint: payload.runtimeEntrypoint ?? null,
        },
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

if (cmd === 'status') {
  const state = readState();
  const health = await checkHealth();
  const version = await checkVersion();
  console.log(`[bootstrap] State file: ${state ? JSON.stringify(state) : 'missing'}`);
  console.log(`[bootstrap] Health: ${health ? JSON.stringify(health) : 'unreachable'}`);
  console.log(`[bootstrap] Version: ${version ? JSON.stringify(version) : 'unreachable'}`);
  process.exit(0);
}

if (cmd === 'kill') {
  killOld();
  process.exit(0);
}

if (!acquireLock()) {
  console.log('[bootstrap] Another bootstrap is running (lock file exists). Aborting.');
  process.exit(1);
}

try {
  console.log('[bootstrap] === AHA BOOTSTRAP RESTART ===');

  const oldState = readState();
  const oldHealth = await checkHealth();
  const oldVersion = await checkVersion();
  const oldPid = oldState?.pid ?? oldVersion?.pid ?? null;
  const oldBuildHash = oldState?.startedWithBuildHash ?? oldVersion?.buildHash ?? null;

  console.log(`[bootstrap] Current state: ${oldHealth ? 'ALIVE' : 'DEAD'}`);
  console.log(`[bootstrap] Current version: ${oldVersion ? JSON.stringify(oldVersion) : 'unknown'}`);

  const killedPid = killOld();
  if (killedPid) {
    await waitDead(killedPid);
    console.log('[bootstrap] Old daemon stopped');
  }

  await sleep(500);

  const newPid = await startNew();
  console.log('[bootstrap] Waiting for new daemon to be ready...');
  const version = await waitReady(oldPid, oldBuildHash);

  if (version) {
    const payload = {
      at: new Date().toISOString(),
      oldPid,
      newPid: version.pid ?? newPid,
      oldBuildHash,
      newBuildHash: version.buildHash ?? null,
      runtimeEntrypoint: version.runtimeEntrypoint ?? null,
      version: version.version ?? null,
    };
    writeHandoff(payload);
    const notified = await sendTeamHandoff(payload);
    console.log(`\n[bootstrap] ✅ RESTART COMPLETE — new PID: ${version.pid ?? newPid}`);
    console.log(`[bootstrap] Build hash switched: ${oldBuildHash ?? 'unknown'} -> ${version.buildHash ?? 'unknown'}`);
    console.log(`[bootstrap] Handoff written: ${HANDOFF_FILE}`);
    console.log(`[bootstrap] Team handoff message: ${notified ? 'sent' : 'skipped'}`);
  } else {
    console.log(`\n[bootstrap] ❌ Daemon started (PID ${newPid}) but ready/version verification timed out`);
  }
} finally {
  releaseLock();
}
