#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(projectRoot, 'bin', 'aha.mjs');

const env = {
  ...process.env,
  AHA_HOME_DIR: process.env.AHA_HOME_DIR ?? join(homedir(), '.aha-v11'),
  AHA_SERVER_URL: process.env.AHA_SERVER_URL ?? 'http://localhost:3305',
  AHA_WEBAPP_URL: process.env.AHA_WEBAPP_URL ?? 'http://localhost:8085',
  GENOME_HUB_URL: process.env.GENOME_HUB_URL ?? 'http://localhost:3306',
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
