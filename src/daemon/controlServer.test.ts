import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mockConfiguration = vi.hoisted(() => ({
    ahaHomeDir: '/tmp/test-aha',
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

import { startDaemonControlServer } from './controlServer';
import { TrackedSession } from './types';

describe('controlServer /team-pulse', () => {
    let stopServer: () => Promise<void>;
    let port: number;
    const trackedSessions: TrackedSession[] = [];

    beforeEach(async () => {
        trackedSessions.length = 0;

        const result = await startDaemonControlServer({
            getChildren: () => trackedSessions,
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error' as const, errorMessage: 'not implemented' }),
            requestShutdown: () => {},
            onAhaSessionWebhook: () => {},
            getTeamPulse: (teamId: string) => {
                // Simulate: return sessions matching team
                return trackedSessions
                    .filter(s => {
                        const meta = s.ahaSessionMetadataFromLocalWebhook;
                        return (meta?.teamId || meta?.roomId) === teamId && s.ahaSessionId;
                    })
                    .map(s => ({
                        sessionId: s.ahaSessionId!,
                        role: s.ahaSessionMetadataFromLocalWebhook?.role || 'unknown',
                        status: 'alive' as const,
                        lastSeenMs: 0,
                        pid: s.pid,
                        runtimeType: s.ahaSessionMetadataFromLocalWebhook?.flavor,
                    }));
            },
        });

        port = result.port;
        stopServer = result.stop;
    });

    afterEach(async () => {
        await stopServer();
    });

    it('should return empty members for unknown team', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/team-pulse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: 'non-existent' }),
        });

        expect(response.ok).toBe(true);
        const data = await response.json() as { teamId: string; members: unknown[]; summary: string };
        expect(data.teamId).toBe('non-existent');
        expect(data.members).toHaveLength(0);
        expect(data.summary).toBe('No agents tracked');
    });

    it('should return members for a team with sessions', async () => {
        trackedSessions.push({
            startedBy: 'daemon',
            ahaSessionId: 'session-1',
            pid: 12345,
            ahaSessionMetadataFromLocalWebhook: {
                teamId: 'team-alpha',
                role: 'builder',
                flavor: 'claude',
            } as any,
        });
        trackedSessions.push({
            startedBy: 'daemon',
            ahaSessionId: 'session-2',
            pid: 12346,
            ahaSessionMetadataFromLocalWebhook: {
                teamId: 'team-alpha',
                role: 'supervisor',
                flavor: 'claude',
            } as any,
        });

        const response = await fetch(`http://127.0.0.1:${port}/team-pulse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: 'team-alpha' }),
        });

        expect(response.ok).toBe(true);
        const data = await response.json() as { teamId: string; members: Array<{ sessionId: string; role: string; status: string }>; summary: string };
        expect(data.teamId).toBe('team-alpha');
        expect(data.members).toHaveLength(2);
        expect(data.members[0].role).toBe('builder');
        expect(data.members[1].role).toBe('supervisor');
        expect(data.summary).toContain('2 alive');
    });

    it('should not include sessions from other teams', async () => {
        trackedSessions.push({
            startedBy: 'daemon',
            ahaSessionId: 'session-1',
            pid: 12345,
            ahaSessionMetadataFromLocalWebhook: {
                teamId: 'team-alpha',
                role: 'builder',
            } as any,
        });
        trackedSessions.push({
            startedBy: 'daemon',
            ahaSessionId: 'session-2',
            pid: 12346,
            ahaSessionMetadataFromLocalWebhook: {
                teamId: 'team-beta',
                role: 'builder',
            } as any,
        });

        const response = await fetch(`http://127.0.0.1:${port}/team-pulse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: 'team-alpha' }),
        });

        const data = await response.json() as { members: unknown[] };
        expect(data.members).toHaveLength(1);
    });
});

describe('controlServer /health + /version', () => {
    let stopServer: () => Promise<void>;
    let port: number;

    beforeEach(async () => {
        const result = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error' as const, errorMessage: 'not implemented' }),
            getDaemonStatus: () => ({
                pid: 4242,
                httpPort: 3000,
                startTime: '2026-04-05T00:00:00.000Z',
                startedWithCliVersion: '1.2.3',
                startedWithBuildHash: 'hash1234',
                runtimeEntrypoint: 'index-hash1234.mjs',
            }),
            requestShutdown: () => {},
            onAhaSessionWebhook: () => {},
        });

        port = result.port;
        stopServer = result.stop;
    });

    afterEach(async () => {
        await stopServer();
    });

    it('serves /health with the daemon contract surface', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(response.ok).toBe(true);
        await expect(response.json()).resolves.toEqual({
            ok: true,
            pid: 4242,
            httpPort: 3000,
            version: '1.2.3',
            buildHash: 'hash1234',
            runtimeEntrypoint: 'index-hash1234.mjs',
            startTime: '2026-04-05T00:00:00.000Z',
        });
    });

    it('serves /version with build identity details', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/version`);
        expect(response.ok).toBe(true);
        await expect(response.json()).resolves.toEqual({
            ok: true,
            pid: 4242,
            httpPort: 3000,
            version: '1.2.3',
            buildHash: 'hash1234',
            runtimeEntrypoint: 'index-hash1234.mjs',
            startTime: '2026-04-05T00:00:00.000Z',
        });
    });
});

describe('controlServer /list', () => {
    let stopServer: () => Promise<void>;
    let port: number;
    const trackedSessions: TrackedSession[] = [];

    beforeEach(async () => {
        trackedSessions.length = 0;

        const result = await startDaemonControlServer({
            getChildren: () => trackedSessions,
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error' as const, errorMessage: 'not implemented' }),
            requestShutdown: () => {},
            onAhaSessionWebhook: () => {},
        });

        port = result.port;
        stopServer = result.stop;
    });

    afterEach(async () => {
        await stopServer();
    });

    it('returns PID fallbacks for recovered sessions that have not self-healed yet', async () => {
        trackedSessions.push({
            startedBy: 'recovered after daemon restart',
            pid: 12345,
        });
        trackedSessions.push({
            startedBy: 'daemon',
            ahaSessionId: 'session-2',
            pid: 12346,
        });

        const response = await fetch(`http://127.0.0.1:${port}/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(response.ok).toBe(true);
        const data = await response.json() as {
            children: Array<{ startedBy: string; ahaSessionId: string; pid: number }>;
        };

        expect(data.children).toEqual([
            {
                startedBy: 'recovered after daemon restart',
                ahaSessionId: 'PID-12345',
                pid: 12345,
            },
            {
                startedBy: 'daemon',
                ahaSessionId: 'session-2',
                pid: 12346,
            },
        ]);
    });
});

describe('controlServer /spawn-session', () => {
    let stopServer: () => Promise<void> = async () => {};
    let port: number;

    afterEach(async () => {
        await stopServer();
    });

    it('returns 202 pending when the child process started but webhook binding is still pending', async () => {
        const result = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({
                type: 'pending' as const,
                pendingSessionId: 'pending-pid-77777',
                pid: 77777,
            }),
            requestShutdown: () => {},
            onAhaSessionWebhook: () => {},
        });

        port = result.port;
        stopServer = result.stop;

        const response = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: process.cwd(),
                role: 'builder',
                sessionName: 'Pending Builder',
            }),
        });

        expect(response.status).toBe(202);
        const data = await response.json() as {
            success: boolean;
            pending: boolean;
            pendingSessionId: string;
            pid: number;
        };
        expect(data).toEqual({
            success: true,
            pending: true,
            pendingSessionId: 'pending-pid-77777',
            pid: 77777,
            approvedNewDirectoryCreation: true,
        });
    });
});

describe('controlServer /channels', () => {
    let stopServer: () => Promise<void>;
    let port: number;
    const seenEvents: any[] = [];
    const policyUpdates: string[] = [];

    beforeEach(async () => {
        seenEvents.length = 0;
        policyUpdates.length = 0;

        const result = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error' as const, errorMessage: 'not implemented' }),
            requestShutdown: () => {},
            onAhaSessionWebhook: () => {},
            getChannelStatus: () => ({
                weixin: {
                    configured: true,
                    connected: true,
                    pushPolicy: 'important',
                },
            }),
            connectWeixin: async () => ({ success: true }),
            disconnectWeixin: async () => ({ success: true }),
            setWeixinPushPolicy: async (policy) => {
                policyUpdates.push(policy);
                return { success: true };
            },
            onChannelNotify: async (event) => {
                seenEvents.push(event);
            },
        });

        port = result.port;
        stopServer = result.stop;
    });

    afterEach(async () => {
        await stopServer();
    });

    it('reports channel status', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/channels/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(response.ok).toBe(true);
        const data = await response.json() as { status: { weixin: { configured: boolean; connected: boolean; pushPolicy: string } } };
        expect(data.status.weixin).toEqual({
            configured: true,
            connected: true,
            pushPolicy: 'important',
        });
    });

    it('accepts channel notify events', async () => {
        const event = {
            id: 'msg-1',
            teamId: 'team-1',
            content: 'hello',
            type: 'chat',
            timestamp: Date.now(),
            fromRole: 'builder',
        };

        const response = await fetch(`http://127.0.0.1:${port}/channels/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event }),
        });

        expect(response.ok).toBe(true);
        expect(seenEvents).toHaveLength(1);
        expect(seenEvents[0]).toMatchObject(event);
    });

    it('updates push policy', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/channels/weixin/policy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pushPolicy: 'silent' }),
        });

        expect(response.ok).toBe(true);
        expect(policyUpdates).toEqual(['silent']);
    });
});

describe('controlServer /heartbeat-ping', () => {
    let stopServer: () => Promise<void>;
    let port: number;
    const pings: Array<{ sessionId: string; teamId: string; role: string }> = [];

    beforeEach(async () => {
        pings.length = 0;

        const result = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error' as const, errorMessage: 'not implemented' }),
            requestShutdown: () => {},
            onAhaSessionWebhook: () => {},
            onHeartbeatPing: (sessionId, teamId, role) => {
                pings.push({ sessionId, teamId, role });
            },
        });

        port = result.port;
        stopServer = result.stop;
    });

    afterEach(async () => {
        await stopServer();
    });

    it('should accept heartbeat ping and invoke callback', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/heartbeat-ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'sess-1', teamId: 'team-a', role: 'builder' }),
        });

        const body = await response.text();
        expect(response.ok).toBe(true);
        const data = JSON.parse(body) as { ok: boolean };
        expect(data.ok).toBe(true);
        expect(pings).toHaveLength(1);
        expect(pings[0]).toEqual({ sessionId: 'sess-1', teamId: 'team-a', role: 'builder' });
    });

    it('should work without onHeartbeatPing callback', async () => {
        await stopServer();
        const result = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error' as const, errorMessage: 'not implemented' }),
            requestShutdown: () => {},
            onAhaSessionWebhook: () => {},
            // No onHeartbeatPing
        });
        port = result.port;
        stopServer = result.stop;

        const response = await fetch(`http://127.0.0.1:${port}/heartbeat-ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'sess-1', teamId: 'team-a', role: 'builder' }),
        });

        expect(response.ok).toBe(true);
    });
});
