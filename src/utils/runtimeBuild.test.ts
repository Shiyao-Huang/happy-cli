import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildRuntimeBuildMetadata, MIRROR_CONTRACT_VERSION } from './runtimeBuild';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));

describe('buildRuntimeBuildMetadata', () => {
    it('captures git-backed runtime build identity without persisting absolute paths', () => {
        vi.mocked(execFileSync).mockImplementation((_command, args) => {
            const joinedArgs = Array.isArray(args) ? args.join(' ') : '';
            if (joinedArgs.includes('rev-parse --show-toplevel')) {
                return '/Users/copizza/Desktop/happyhere/aha-cli-0330-max-redefine-login\n' as any;
            }
            if (joinedArgs.includes('rev-parse HEAD')) {
                return '1234567890abcdef1234567890abcdef12345678\n' as any;
            }
            if (joinedArgs.includes('rev-parse --abbrev-ref HEAD')) {
                return 'feature/runtime-build\n' as any;
            }
            throw new Error(`unexpected git call: ${joinedArgs}`);
        });

        expect(buildRuntimeBuildMetadata({
            cwd: '/Users/copizza/Desktop/happyhere/aha-cli-0330-max-redefine-login/src',
            runtime: 'claude',
            startedAt: 1_717_171_717_000,
        })).toEqual({
            gitSha: '1234567890abcdef1234567890abcdef12345678',
            branch: 'feature/runtime-build',
            worktreeName: 'aha-cli-0330-max-redefine-login',
            runtime: 'claude',
            startedAt: 1_717_171_717_000,
            mirrorContractVersion: MIRROR_CONTRACT_VERSION,
        });
    });

    it('falls back to the cwd basename when git metadata is unavailable', () => {
        vi.mocked(execFileSync).mockImplementation(() => {
            throw new Error('not a git repo');
        });

        expect(buildRuntimeBuildMetadata({
            cwd: '/tmp/codex-session-worktree',
            runtime: 'codex',
            startedAt: 42,
        })).toEqual({
            gitSha: null,
            branch: null,
            worktreeName: 'codex-session-worktree',
            runtime: 'codex',
            startedAt: 42,
            mirrorContractVersion: MIRROR_CONTRACT_VERSION,
        });
    });
});
