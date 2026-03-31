import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PUBLISH_PROTECTED_EXTENSIONS = ['.js', '.mjs', '.cjs'];

export function isPublishProtectedArtifact(filePath) {
  return PUBLISH_PROTECTED_EXTENSIONS.includes(path.extname(filePath));
}

export function resolvePublishProtectionPolicy(env = process.env) {
  const raw = String(env.AHA_NPM_PUBLISH_ENCRYPTION ?? 'obfuscate').trim().toLowerCase();

  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'none' || raw === 'disabled') {
    return {
      enabled: false,
      mode: 'none',
    };
  }

  return {
    enabled: true,
    mode: 'obfuscate',
  };
}

export async function collectPublishProtectedArtifacts(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPublishProtectedArtifacts(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isPublishProtectedArtifact(fullPath)) continue;
    files.push(fullPath);
  }

  return files.sort();
}

export async function protectPublishArtifacts(options) {
  const files = await collectPublishProtectedArtifacts(options.rootDir);

  for (const filePath of files) {
    const code = await readFile(filePath, 'utf8');
    const transformed = await options.transform(code, filePath);
    await writeFile(filePath, transformed, 'utf8');
  }

  return files;
}
