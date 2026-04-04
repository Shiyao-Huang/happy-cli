import { describe, expect, it } from 'vitest';
import { buildCodexRuntimeMetadata } from '../runtimeMetadata';

describe('buildCodexRuntimeMetadata', () => {
    it('removes stale visible tool inventory while syncing codex runtime permissions', () => {
        const result = buildCodexRuntimeMetadata({
            path: '/tmp/agent',
            host: 'localhost',
            role: 'implementer',
            flavor: 'codex',
            tools: ['mcp__aha__get_self_view'],
            runtimeBuild: {
                gitSha: 'abcdef',
                runtime: 'codex',
                startedAt: 42,
                mirrorContractVersion: 'runtime-mirror-v1',
            },
            runtimePermissions: {
                source: 'claude-runtime',
                updatedAt: 1,
                permissionMode: 'acceptEdits',
                allowedTools: ['get_self_view'],
                disallowedTools: ['kill_agent'],
            },
        }, {
            permissionMode: 'bypassPermissions',
            updatedAt: 99,
        });

        expect(result).toMatchObject({
            role: 'implementer',
            flavor: 'codex',
            runtimeBuild: {
                gitSha: 'abcdef',
                runtime: 'codex',
                startedAt: 42,
                mirrorContractVersion: 'runtime-mirror-v1',
            },
            runtimePermissions: {
                source: 'codex-runtime',
                updatedAt: 99,
                permissionMode: 'bypassPermissions',
            },
        });
        expect(result).not.toHaveProperty('tools');
        expect(result.runtimePermissions).not.toHaveProperty('allowedTools');
        expect(result.runtimePermissions).not.toHaveProperty('disallowedTools');
    });

    it('preserves required session metadata while rewriting codex runtime permissions', () => {
        const result = buildCodexRuntimeMetadata({
            path: '/tmp/agent',
            host: 'localhost',
            machineId: 'machine-1',
            role: 'implementer',
            tools: ['mcp__aha__list_tasks'],
        }, {
            permissionMode: 'read-only',
            updatedAt: 123,
        });

        expect(result).toEqual({
            path: '/tmp/agent',
            host: 'localhost',
            machineId: 'machine-1',
            role: 'implementer',
            runtimePermissions: {
                source: 'codex-runtime',
                updatedAt: 123,
                permissionMode: 'read-only',
            },
        });
    });
});
