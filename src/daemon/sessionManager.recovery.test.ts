import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: mockLogger,
}));

vi.mock('@/api/api', () => ({
    ApiClient: class {},
}));

vi.mock('@/claude/team/heartbeat', () => ({
    AgentHeartbeat: class {},
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({}));

vi.mock('@/utils/spawnAhaCLI', () => ({
    spawnAhaCLI: vi.fn(),
}));

vi.mock('@/utils/agentLaunchContext', () => ({
    buildAgentLaunchContext: vi.fn(() => ({ prompt: '', scopeSummary: '' })),
}));

vi.mock('@/trace/traceEmitter', () => ({
    emitTraceEvent: vi.fn(),
    emitTraceLink: vi.fn(),
}));

vi.mock('@/trace/traceTypes', () => ({
    TraceEventKind: {},
}));

import { initSessionManagerHeartbeat, onAhaSessionWebhook, pidToTrackedSession } from './sessionManager';

describe('sessionManager recovered session self-heal', () => {
    const pingHeartbeat = vi.fn();

    beforeEach(() => {
        pidToTrackedSession.clear();
        pingHeartbeat.mockReset();
        initSessionManagerHeartbeat(pingHeartbeat);
    });

    it('heals a recovered session when the real webhook arrives for the same pid', () => {
        pidToTrackedSession.set(12345, {
            startedBy: 'recovered after daemon restart',
            pid: 12345,
            ahaSessionMetadataFromLocalWebhook: {
                teamId: 'team-1',
                roomId: 'team-1',
                hostPid: 12345,
                memberId: 'member-1',
            } as any,
        });

        onAhaSessionWebhook('cmn-real-session', {
            hostPid: 12345,
            teamId: 'team-1',
            roomId: 'team-1',
            role: 'builder',
            executionPlane: 'mainline',
            memberId: 'member-1',
            sessionTag: 'team:team-1:member:member-1',
            flavor: 'claude',
            name: 'Builder 1',
        } as any);

        const healed = pidToTrackedSession.get(12345);
        expect(healed?.startedBy).toBe('daemon');
        expect(healed?.ahaSessionId).toBe('cmn-real-session');
        expect(healed?.ahaSessionMetadataFromLocalWebhook?.role).toBe('builder');
        expect(healed?.ahaSessionMetadataFromLocalWebhook?.executionPlane).toBe('mainline');
        expect(healed?.ahaSessionMetadataFromLocalWebhook?.name).toBe('Builder 1');
        expect(healed?.ahaSessionMetadataFromLocalWebhook?.flavor).toBe('claude');
        expect(pingHeartbeat).toHaveBeenCalledTimes(1);
    });
});
