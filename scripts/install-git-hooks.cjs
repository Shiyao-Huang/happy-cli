#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MANAGED_MARKER = '# aha-cli managed pre-commit hook';
const LEGACY_BROKEN_SNIPPET = './node_modules/pre-commit/hook';

function resolveHooksDirectory() {
  try {
    const output = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) return null;
    return path.resolve(process.cwd(), output);
  } catch {
    return null;
  }
}

function buildHookContent() {
  return `#!/bin/sh
${MANAGED_MARKER}
set -eu

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

if command -v yarn >/dev/null 2>&1; then
  exec yarn prerecommit
fi

echo "[aha-cli] yarn is required to run prerecommit." >&2
exit 1
`;
}

function installPreCommitHook() {
  const hooksDir = resolveHooksDirectory();
  if (!hooksDir || !fs.existsSync(hooksDir)) {
    console.log('[aha-cli] Git hooks directory not found; skipping hook install.');
    return;
  }

  const hookPath = path.join(hooksDir, 'pre-commit');
  const nextContent = buildHookContent();

  if (fs.existsSync(hookPath)) {
    const currentContent = fs.readFileSync(hookPath, 'utf8');
    const isManaged = currentContent.includes(MANAGED_MARKER);
    const isLegacyBroken = currentContent.includes(LEGACY_BROKEN_SNIPPET);

    if (!isManaged && !isLegacyBroken) {
      console.log('[aha-cli] Existing custom pre-commit hook detected; leaving it unchanged.');
      return;
    }

    if (currentContent === nextContent) {
      console.log('[aha-cli] Pre-commit hook already up to date.');
      return;
    }
  }

  fs.writeFileSync(hookPath, nextContent, 'utf8');
  fs.chmodSync(hookPath, 0o755);
  console.log(`[aha-cli] Installed managed pre-commit hook at ${hookPath}`);
}

installPreCommitHook();
