import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';

export interface RuntimeBuildInfo {
  version: string;
  runtimeEntrypoint: string | null;
  buildHash: string | null;
  diskEntrypoint: string | null;
}

export function extractBuildHashFromEntrypoint(entrypoint: string | null | undefined): string | null {
  if (!entrypoint) return null;
  const match = basename(entrypoint).match(/^index-([A-Za-z0-9_-]+)\.(?:mjs|cjs)$/);
  return match?.[1] ?? null;
}

export function resolveRuntimeBuildInfo(moduleUrl: string, root: string = projectPath()): RuntimeBuildInfo {
  let runtimeEntrypoint: string | null = null;
  try {
    runtimeEntrypoint = basename(fileURLToPath(moduleUrl));
  } catch {
    runtimeEntrypoint = null;
  }

  let diskEntrypoint: string | null = null;
  const diskIndexPath = join(root, 'dist', 'index.mjs');
  if (existsSync(diskIndexPath)) {
    try {
      const content = readFileSync(diskIndexPath, 'utf-8');
      const match = content.match(/\.\/(index-[A-Za-z0-9_-]+\.mjs)/);
      diskEntrypoint = match?.[1] ?? null;
    } catch {
      diskEntrypoint = null;
    }
  }

  return {
    version: configuration.currentCliVersion,
    runtimeEntrypoint,
    buildHash: extractBuildHashFromEntrypoint(runtimeEntrypoint),
    diskEntrypoint,
  };
}
