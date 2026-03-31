#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePublishProtectionPolicy } from './lib/npmPublishProtection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const policy = resolvePublishProtectionPolicy(process.env);

if (!policy.enabled) {
  console.log('[prepare-npm-package] Publish protection disabled via AHA_NPM_PUBLISH_ENCRYPTION');
  process.exit(0);
}

await import(path.join(repoRoot, 'scripts', 'obfuscate-dist.mjs'));
console.log(`[prepare-npm-package] Publish protection mode applied: ${policy.mode}`);
