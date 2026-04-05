import { describe, expect, it } from 'vitest';

import { extractBuildHashFromEntrypoint, resolveRuntimeBuildInfo } from './runtimeBuildInfo';

describe('runtimeBuildInfo', () => {
  it('extracts build hashes from hashed entrypoint names', () => {
    expect(extractBuildHashFromEntrypoint('index-BzU4uGQP.mjs')).toBe('BzU4uGQP');
    expect(extractBuildHashFromEntrypoint('index-Bsy3_kc6.cjs')).toBe('Bsy3_kc6');
    expect(extractBuildHashFromEntrypoint('run.ts')).toBeNull();
  });

  it('returns runtime and disk entrypoint information', () => {
    const info = resolveRuntimeBuildInfo('file:///tmp/index-AbCd1234.mjs', process.cwd());

    expect(info.version).toBeTypeOf('string');
    expect(info.runtimeEntrypoint).toBe('index-AbCd1234.mjs');
    expect(info.buildHash).toBe('AbCd1234');
    expect(info.diskEntrypoint === null || info.diskEntrypoint.startsWith('index-')).toBe(true);
  });
});
