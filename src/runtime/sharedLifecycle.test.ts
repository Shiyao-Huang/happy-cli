/**
 * Shared Session Lifecycle Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSessionMetadataFromEnv, resolvePermissionMode } from './sharedLifecycle';

describe('buildSessionMetadataFromEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('builds base metadata with required fields', () => {
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp/test',
            processStartedAt: 1000,
            machineId: 'machine-123',
            flavor: 'claude',
            sessionTag: 'tag-456',
            ahaHomeDir: '/home/.aha-dev',
            ahaLibDir: '/lib/aha',
        });

        expect(metadata.path).toBe('/tmp/test');
        expect(metadata.machineId).toBe('machine-123');
        expect(metadata.flavor).toBe('claude');
        expect(metadata.sessionTag).toBe('tag-456');
        expect(metadata.lifecycleState).toBe('running');
        expect(metadata.hostPid).toBe(process.pid);
        expect(metadata.ahaHomeDir).toBe('/home/.aha-dev');
        expect(metadata.ahaLibDir).toBe('/lib/aha');
    });

    it('populates role from env', () => {
        process.env.AHA_AGENT_ROLE = 'master';
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp',
            processStartedAt: 0,
            machineId: 'm1',
            flavor: 'codex',
            sessionTag: 't1',
            ahaHomeDir: '/aha',
            ahaLibDir: '/lib',
        });
        expect(metadata.role).toBe('master');
    });

    it('populates teamId from AHA_ROOM_ID', () => {
        process.env.AHA_ROOM_ID = 'room-abc';
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp',
            processStartedAt: 0,
            machineId: 'm1',
            flavor: 'claude',
            sessionTag: 't1',
            ahaHomeDir: '/aha',
            ahaLibDir: '/lib',
        });
        expect(metadata.teamId).toBe('room-abc');
    });

    it('populates executionPlane from env', () => {
        process.env.AHA_EXECUTION_PLANE = 'mainline';
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp',
            processStartedAt: 0,
            machineId: 'm1',
            flavor: 'claude',
            sessionTag: 't1',
            ahaHomeDir: '/aha',
            ahaLibDir: '/lib',
        });
        expect(metadata.executionPlane).toBe('mainline');
    });

    it('populates name from AHA_SESSION_NAME over AHA_ROOM_NAME', () => {
        process.env.AHA_SESSION_NAME = 'session-name';
        process.env.AHA_ROOM_NAME = 'room-name';
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp',
            processStartedAt: 0,
            machineId: 'm1',
            flavor: 'claude',
            sessionTag: 't1',
            ahaHomeDir: '/aha',
            ahaLibDir: '/lib',
        });
        expect(metadata.name).toBe('session-name');
    });

    it('populates name from AHA_ROOM_NAME when no SESSION_NAME', () => {
        delete process.env.AHA_SESSION_NAME;
        process.env.AHA_ROOM_NAME = 'room-name';
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp',
            processStartedAt: 0,
            machineId: 'm1',
            flavor: 'claude',
            sessionTag: 't1',
            ahaHomeDir: '/aha',
            ahaLibDir: '/lib',
        });
        expect(metadata.name).toBe('room-name');
    });

    it('marks startedFromDaemon when startedBy is daemon', () => {
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp',
            processStartedAt: 0,
            machineId: 'm1',
            flavor: 'codex',
            sessionTag: 't1',
            startedBy: 'daemon',
            ahaHomeDir: '/aha',
            ahaLibDir: '/lib',
        });
        expect(metadata.startedFromDaemon).toBe(true);
        expect(metadata.startedBy).toBe('daemon');
    });

    it('defaults startedBy to terminal', () => {
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp',
            processStartedAt: 0,
            machineId: 'm1',
            flavor: 'claude',
            sessionTag: 't1',
            ahaHomeDir: '/aha',
            ahaLibDir: '/lib',
        });
        expect(metadata.startedBy).toBe('terminal');
    });

    it('handles candidateIdentity JSON parse failure gracefully', () => {
        process.env.AHA_CANDIDATE_IDENTITY_JSON = 'not-valid-json';
        const metadata = buildSessionMetadataFromEnv({
            workingDirectory: '/tmp',
            processStartedAt: 0,
            machineId: 'm1',
            flavor: 'claude',
            sessionTag: 't1',
            ahaHomeDir: '/aha',
            ahaLibDir: '/lib',
        });
        // Should not throw, candidateIdentity should remain unset
        expect((metadata as any).candidateIdentity).toBeUndefined();
    });
});

describe('resolvePermissionMode', () => {
    it('returns undefined for empty input', () => {
        expect(resolvePermissionMode()).toBeUndefined();
        expect(resolvePermissionMode('')).toBeUndefined();
    });

    it('resolves "default"', () => {
        expect(resolvePermissionMode('default')).toBe('default');
    });

    it('resolves "plan"', () => {
        expect(resolvePermissionMode('plan')).toBe('plan');
    });

    it('resolves accept variants', () => {
        expect(resolvePermissionMode('accept')).toBe('acceptEdits');
        expect(resolvePermissionMode('accept-edits')).toBe('acceptEdits');
        expect(resolvePermissionMode('acceptedits')).toBe('acceptEdits');
    });

    it('resolves bypass variants', () => {
        expect(resolvePermissionMode('yolo')).toBe('bypassPermissions');
        expect(resolvePermissionMode('bypass')).toBe('bypassPermissions');
        expect(resolvePermissionMode('bypasspermissions')).toBe('bypassPermissions');
        expect(resolvePermissionMode('danger')).toBe('bypassPermissions');
    });

    it('resolves safe-yolo variants', () => {
        expect(resolvePermissionMode('safe-yolo')).toBe('safe-yolo');
        expect(resolvePermissionMode('safe_yolo')).toBe('safe-yolo');
        expect(resolvePermissionMode('safe')).toBe('safe-yolo');
    });

    it('resolves read-only variants', () => {
        expect(resolvePermissionMode('read-only')).toBe('read-only');
        expect(resolvePermissionMode('readonly')).toBe('read-only');
    });

    it('returns undefined for unknown modes', () => {
        expect(resolvePermissionMode('unknown-mode')).toBeUndefined();
    });

    it('is case-insensitive', () => {
        expect(resolvePermissionMode('DEFAULT')).toBe('default');
        expect(resolvePermissionMode('Plan')).toBe('plan');
        expect(resolvePermissionMode('YOLO')).toBe('bypassPermissions');
    });
});
