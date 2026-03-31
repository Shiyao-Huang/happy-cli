#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(projectRoot, 'bin', 'aha-mcp.mjs');
const ahaHomeDir = process.env.AHA_HOME_DIR ?? join(homedir(), '.aha-v13');
const legacyHomeDir = join(homedir(), '.aha-v12');

mkdirSync(ahaHomeDir, { recursive: true });
for (const filename of ['access.key', 'config.json', 'settings.json']) {
  const targetPath = join(ahaHomeDir, filename);
  const legacyPath = join(legacyHomeDir, filename);
  if (!existsSync(targetPath) && existsSync(legacyPath)) {
    copyFileSync(legacyPath, targetPath);
  }
}

const env = {
  ...process.env,
  AHA_HOME_DIR: ahaHomeDir,
  AHA_SERVER_URL: process.env.AHA_SERVER_URL ?? 'http://localhost:3505',
  AHA_WEBAPP_URL: process.env.AHA_WEBAPP_URL ?? 'http://localhost:8087',
  GENOME_HUB_URL: process.env.GENOME_HUB_URL ?? 'http://localhost:3506',
  DEBUG: process.env.DEBUG ?? '1',
  NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? '1',
};

try {
  execFileSync(process.execPath, [entrypoint, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
} catch (error) {
  process.exit(error.status || 1);
}
