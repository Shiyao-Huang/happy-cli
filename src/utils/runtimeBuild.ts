import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { Metadata } from '@/api/types';

export const MIRROR_CONTRACT_VERSION = 'runtime-mirror-v1';

function readGitValue(cwd: string, args: string[]): string | null {
    try {
        const output = execFileSync('git', ['-C', cwd, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3_000,
        }).trim();
        return output || null;
    } catch {
        return null;
    }
}

export function buildRuntimeBuildMetadata(input: {
    cwd: string;
    runtime: 'claude' | 'codex';
    startedAt: number;
}): NonNullable<Metadata['runtimeBuild']> {
    const repoRoot = readGitValue(input.cwd, ['rev-parse', '--show-toplevel']);
    const gitSha = readGitValue(input.cwd, ['rev-parse', 'HEAD']);
    const branch = readGitValue(input.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

    return {
        gitSha,
        branch,
        worktreeName: repoRoot ? basename(repoRoot) : basename(input.cwd),
        runtime: input.runtime,
        startedAt: input.startedAt,
        mirrorContractVersion: MIRROR_CONTRACT_VERSION,
    };
}
