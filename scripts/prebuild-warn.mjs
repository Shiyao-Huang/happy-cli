#!/usr/bin/env node
/**
 * Pre-build warning script.
 *
 * Checks for active daemon sessions before `npm run build` / `yarn build`.
 * When active agent sessions are found, prints a prominent warning — chunk
 * hash invalidation after the build will cause ERR_MODULE_NOT_FOUND for
 * any session that dynamically imports a dist chunk.
 *
 * Exits 0 always (warns but never blocks the build).
 * Set AHA_SKIP_PREBUILD_WARN=1 to suppress.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (process.env.AHA_SKIP_PREBUILD_WARN === '1') process.exit(0);

const ahaHome = process.env.AHA_HOME_DIR || join(homedir(), '.aha');
const stateFile = join(ahaHome, 'daemon.state.json');

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

async function listSessions(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/list`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const state = readState();
if (!state?.httpPort) {
  // Daemon not running — safe to build.
  process.exit(0);
}

const data = await listSessions(state.httpPort);
const count = data?.children?.length ?? 0;

if (count === 0) {
  process.exit(0);
}

const sessions = (data.children ?? [])
  .map(s => `  • ${s.ahaSessionId} (PID ${s.pid}, started-by: ${s.startedBy})`)
  .join('\n');

console.warn(`
╔══════════════════════════════════════════════════════════════════╗
║  ⚠️  AHA BUILD WARNING — ACTIVE SESSIONS WILL DIE               ║
╠══════════════════════════════════════════════════════════════════╣
║  ${count} active agent session${count === 1 ? '' : 's'} found. After this build, new chunk   ║
║  hashes will cause ERR_MODULE_NOT_FOUND for running sessions.    ║
║                                                                  ║
║  Options:                                                        ║
║    1. Stop sessions first: ./bin/aha.mjs daemon stop             ║
║    2. Build anyway and restart: node bootstrap.mjs restart       ║
║    3. Suppress this warning: AHA_SKIP_PREBUILD_WARN=1 yarn build ║
╚══════════════════════════════════════════════════════════════════╝

Active sessions:
${sessions}
`);

// Exit 0 — warn only, never block.
process.exit(0);
