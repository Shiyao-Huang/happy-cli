#!/usr/bin/env node

/**
 * @fileoverview Aha CLI Bootstrapper
 *
 * Responsible for version management and main entrypoint resolution.
 * The bootstrapper is intentionally simple and changes rarely.
 * When aha-agi updates, only the main package changes; the bootstrapper stays the same.
 *
 * Flow:
 *   1. Check local ~/.aha/versions/ for installed versions
 *   2. Check npm registry for latest version (cached, max every 5 min)
 *   3. If new version: npm install to ~/.aha/versions/X.X.X/
 *   4. Atomically switch ~/.aha/current symlink
 *   5. Verify new version with --version
 *   6. Launch main: dist/index.mjs
 *   7. If verification fails: rollback to previous version
 */

import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import https from 'https';

// ── Constants ────────────────────────────────────────────────────────────────

const AHA_HOME = process.env.AHA_HOME_DIR || join(process.env.HOME || process.env.USERPROFILE, '.aha');
const VERSIONS_DIR = join(AHA_HOME, 'versions');
const CURRENT_LINK = join(AHA_HOME, 'current');
const PREVIOUS_LINK = join(AHA_HOME, 'previous');
const CONFIG_PATH = join(AHA_HOME, 'bootstrapper.json');
const REGISTRY_URL = 'https://registry.npmjs.org/aha-agi/latest';
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INSTALL_TIMEOUT_MS = 120_000;

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level, message) {
  if (process.env.AHA_BOOTSTRAPPER_DEBUG || level === 'error') {
    console.error(`[bootstrapper:${level}] ${message}`);
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { currentVersion: null, lastCheck: 0, packageName: 'aha-agi' };
  }
}

function writeConfig(config) {
  mkdirSync(AHA_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Bundled version ──────────────────────────────────────────────────────────

function getBundledVersion() {
  try {
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
    return { version: pkg.version, root: projectRoot };
  } catch {
    return { version: null, root: null };
  }
}

function getBundledEntrypoint() {
  const { root } = getBundledVersion();
  if (!root) return null;
  return join(root, 'dist', 'index.mjs');
}

// ── Registry ─────────────────────────────────────────────────────────────────

function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get(REGISTRY_URL, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.version) resolve(json.version);
          else reject(new Error('Registry response missing version field'));
        } catch (e) {
          reject(new Error(`Failed to parse registry response: ${e.message}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Registry request failed: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Registry request timeout'));
    });
  });
}

// ── Version Management ───────────────────────────────────────────────────────

function getVersionEntrypoint(version) {
  if (!version) return null;
  const versionDir = join(VERSIONS_DIR, version);
  const entrypoint = join(versionDir, 'node_modules', 'aha-agi', 'dist', 'index.mjs');
  return existsSync(entrypoint) ? entrypoint : null;
}

function getCurrentSymlinkEntrypoint() {
  try {
    const resolved = readFileSync(CURRENT_LINK, 'utf-8').trim();
    const entrypoint = join(resolved, 'node_modules', 'aha-agi', 'dist', 'index.mjs');
    return existsSync(entrypoint) ? entrypoint : null;
  } catch {
    return null;
  }
}

function isDevEnvironment() {
  // If we have a src/ directory alongside the bundled dist/, we're in dev
  const { root } = getBundledVersion();
  if (!root) return false;
  return existsSync(join(root, 'src'));
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function installVersion(version) {
  const versionDir = join(VERSIONS_DIR, version);
  mkdirSync(versionDir, { recursive: true });

  // npm install --prefix needs a package.json in the target dir
  const pkgPath = join(versionDir, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: 'aha-bootstrapper-target', version: '1.0.0' }));
  }

  log('info', `Installing aha-agi@${version} to ${versionDir}`);

  try {
    execSync(
      `npm install aha-agi@${version} --prefix ${versionDir} --no-save --no-package-lock`,
      {
        stdio: process.env.AHA_BOOTSTRAPPER_DEBUG ? 'inherit' : 'pipe',
        timeout: INSTALL_TIMEOUT_MS,
        env: { ...process.env, npm_config_loglevel: 'silent' },
      }
    );
    log('info', `Installed aha-agi@${version} successfully`);
    return true;
  } catch (error) {
    log('error', `Failed to install aha-agi@${version}: ${error.message}`);
    return false;
  }
}

function verifyVersion(entrypoint) {
  try {
    const result = execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      '--version',
    ], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return result.trim();
  } catch (error) {
    log('error', `Version verification failed for ${entrypoint}: ${error.message}`);
    return null;
  }
}

function atomicSwitch(version, versionDir) {
  try {
    // Save previous
    if (existsSync(CURRENT_LINK)) {
      try {
        const previous = readFileSync(CURRENT_LINK, 'utf-8').trim();
        writeFileSync(PREVIOUS_LINK, previous);
      } catch { /* ignore */ }
      unlinkSync(CURRENT_LINK);
    }
    // Create new current link (as text file containing path, for cross-platform)
    writeFileSync(CURRENT_LINK, versionDir);
    log('info', `Switched to version ${version}`);
    return true;
  } catch (error) {
    log('error', `Failed to switch version: ${error.message}`);
    return false;
  }
}

function rollback() {
  try {
    if (!existsSync(PREVIOUS_LINK)) {
      log('error', 'No previous version to rollback to');
      return false;
    }
    const previous = readFileSync(PREVIOUS_LINK, 'utf-8').trim();
    if (existsSync(CURRENT_LINK)) unlinkSync(CURRENT_LINK);
    writeFileSync(CURRENT_LINK, previous);
    log('info', `Rolled back to ${previous}`);
    return true;
  } catch (error) {
    log('error', `Rollback failed: ${error.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function resolveEntrypoint() {
  // Skip bootstrapper in dev environment
  if (isDevEnvironment()) {
    log('debug', 'Dev environment detected; using bundled entrypoint');
    return getBundledEntrypoint();
  }

  const config = readConfig();
  const now = Date.now();
  let targetEntrypoint = null;
  let targetVersion = config.currentVersion;
  const bundled = getBundledVersion();

  // Try current symlink first
  targetEntrypoint = getCurrentSymlinkEntrypoint();
  if (targetEntrypoint) {
    log('debug', `Using current symlink: ${targetEntrypoint}`);
  }

  // A freshly installed npm package should not be shadowed by an older cached
  // entrypoint. This is especially important for one-shot join commands that
  // depend on newly added CLI flags.
  if (
    targetEntrypoint
    && bundled.version
    && targetVersion
    && compareVersions(bundled.version, targetVersion) >= 0
  ) {
    log('debug', `Bundled version ${bundled.version} >= cached ${targetVersion}; using bundled entrypoint`);
    return getBundledEntrypoint();
  }

  // Check for updates (non-blocking, failures are logged but not fatal)
  if (!targetEntrypoint || now - config.lastCheck > CHECK_INTERVAL_MS) {
    try {
      const latestVersion = await fetchLatestVersion();
      config.lastCheck = now;

      // Never downgrade: skip if bundled version is newer or equal
      if (bundled.version && compareVersions(latestVersion, bundled.version) <= 0) {
        log('debug', `Registry version ${latestVersion} <= bundled ${bundled.version}; skipping update`);
        writeConfig(config);
        return getBundledEntrypoint();
      }

      if (latestVersion !== config.currentVersion) {
        log('info', `New version available: ${latestVersion} (current: ${config.currentVersion || 'none'})`);

        const installed = installVersion(latestVersion);
        if (installed) {
          const newEntrypoint = getVersionEntrypoint(latestVersion);
          if (newEntrypoint) {
            const verified = verifyVersion(newEntrypoint);
            if (verified) {
              const versionDir = join(VERSIONS_DIR, latestVersion);
              atomicSwitch(latestVersion, versionDir);
              targetEntrypoint = newEntrypoint;
              targetVersion = latestVersion;
              config.currentVersion = latestVersion;
              log('info', `Activated aha-agi@${latestVersion} (${verified})`);
            } else {
              log('error', `Version verification failed for ${latestVersion}, keeping current`);
            }
          }
        }
      } else {
        log('debug', `Version ${latestVersion} already current`);
      }
    } catch (error) {
      log('error', `Update check failed: ${error.message}`);
    }
    writeConfig(config);
  }

  // Fallback chain
  if (!targetEntrypoint) {
    targetEntrypoint = getVersionEntrypoint(targetVersion);
  }
  if (!targetEntrypoint) {
    targetEntrypoint = getBundledEntrypoint();
    log('debug', `Using bundled entrypoint: ${targetEntrypoint}`);
  }

  return targetEntrypoint;
}

// CLI entrypoint for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  resolveEntrypoint()
    .then((entrypoint) => {
      console.log(entrypoint);
    })
    .catch((error) => {
      console.error('Bootstrapper failed:', error);
      process.exit(1);
    });
}
