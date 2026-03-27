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

# Serialize concurrent tsc runs to avoid multi-agent prerecommit OOM on shared machines.
LOCK_DIR="/tmp/aha-tsc-lock"
LOCK_TIMEOUT=180
elapsed=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if [ $elapsed -ge $LOCK_TIMEOUT ]; then
    echo "[aha-cli] Timeout waiting for tsc lock after \${LOCK_TIMEOUT}s. Another pre-commit hook may be hung. Delete /tmp/aha-tsc-lock to reset." >&2
    exit 1
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM HUP

NODE_VERSION="$(cat .node-version 2>/dev/null || echo 22)"
NODE_OPTIONS_VALUE="--max-old-space-size=10240"

if command -v yarn >/dev/null 2>&1; then
  if command -v fnm >/dev/null 2>&1; then
    SHELL_BIN="$(command -v zsh || command -v bash || command -v sh)"
    "$SHELL_BIN" -lc "eval \"\$(fnm env)\" && fnm use \${NODE_VERSION} --silent-if-unchanged >/dev/null && NODE_OPTIONS=\"\${NODE_OPTIONS_VALUE}\" yarn prerecommit"
    exit $?
  fi

  NODE_OPTIONS="\${NODE_OPTIONS_VALUE}" yarn prerecommit
  exit $?
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
