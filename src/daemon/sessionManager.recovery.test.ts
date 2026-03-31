import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
}));
const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawnAhaCLI = vi.hoisted(() => vi.fn());

vi.mock('@/ui/logger', () => ({
    logger: mockLogger,
}));

vi.mock('child_process', () => ({
    execSync: mockExecSync,
}));

vi.mock('@/api/api', () => ({
    ApiClient: class {},
}));

vi.mock('@/claude/team/heartbeat', () => ({
    AgentHeartbeat: class {},
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({}));

vi.mock('@/utils/spawnAhaCLI', () => ({
    spawnAhaCLI: mockSpawnAhaCLI,
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

import {
    initSessionManagerHeartbeat,
    onHeartbeatPrunedSession,
    onAhaSessionWebhook,
    onChildExited,
    pidToTrackedSession,
    resetSessionManagerForTests,
    recoverExistingSessions,
    spawnSession,
} from './sessionManager';

describe('sessionManager recovered session self-heal', () => {
    const pingHeartbeat = vi.fn();
    let killSpy: { mockRestore: () => void } | null = null;

    beforeEach(() => {
        resetSessionManagerForTests();
        pingHeartbeat.mockReset();
        initSessionManagerHeartbeat(pingHeartbeat);
        mockExecSync.mockReset();
        mockSpawnAhaCLI.mockReset();
        killSpy?.mockRestore();
        killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as any);
        process.env.AHA_SESSION_WEBHOOK_TIMEOUT_MS = '10000';
        delete process.env.AHA_MAX_CONCURRENT_CLAUDE_AGENTS;

        mockExecSync.mockImplementation((command: string) => {
            if (command.startsWith('git rev-parse')) return 'true\n';
            if (command.startsWith('git status --porcelain')) return '';
            throw new Error(`Unexpected execSync command: ${command}`);
        });
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
            path: '/Users/copizza/Desktop/happyhere/project-a',
            host: 'test-host',
            homeDir: '/Users/copizza',
            ahaHomeDir: '/Users/copizza/.aha',
            ahaLibDir: '/Users/copizza/Desktop/happyhere/aha-cli-bug-fix-0324',
            ahaToolsDir: '/Users/copizza/Desktop/happyhere/aha-cli-bug-fix-0324/tools/unpacked',
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
        expect(healed?.spawnOptions).toMatchObject({
            directory: '/Users/copizza/Desktop/happyhere/project-a',
            teamId: 'team-1',
            role: 'builder',
            sessionTag: 'team:team-1:member:member-1',
            sessionPath: '/Users/copizza/Desktop/happyhere/project-a',
            env: {
                AHA_TEAM_MEMBER_ID: 'member-1',
            },
        });
        expect(pingHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('hydrates respawn options during recovery from roster data and process cwd', async () => {
        mockExecSync.mockImplementation((command: string) => {
            if (command.startsWith('ps -eo pid,args')) {
                return '12345 /usr/local/bin/aha claude --session-tag team:team-1:member:member-1\n';
            }
            if (command.startsWith('lsof -a -d cwd -Fn -p 12345')) {
                return 'p12345\nn/Users/copizza/Desktop/happyhere/recovered-project\n';
            }
            if (command.startsWith('git rev-parse')) return 'true\n';
            if (command.startsWith('git status --porcelain')) return '';
            throw new Error(`Unexpected execSync command: ${command}`);
        });

        const api = {
            getTeam: vi.fn().mockResolvedValue({
                team: {
                    members: [
                        {
                            memberId: 'member-1',
                            sessionId: 'cmn-session-1',
                            roleId: 'builder',
                            executionPlane: 'mainline',
                            runtimeType: 'claude',
                            displayName: 'Builder 1',
                            sessionTag: 'team:team-1:member:member-1',
                            specId: 'spec-1',
                            parentSessionId: 'parent-1',
                            customPrompt: 'Keep going',
                        },
                    ],
                },
            }),
        };

        const recovered = await recoverExistingSessions(api as any);

        expect(recovered).toBe(1);
        expect(api.getTeam).toHaveBeenCalledWith('team-1');

        const tracked = pidToTrackedSession.get(12345);
        expect(tracked?.spawnOptions).toMatchObject({
            directory: '/Users/copizza/Desktop/happyhere/recovered-project',
            agent: 'claude',
            teamId: 'team-1',
            role: 'builder',
            sessionName: 'Builder 1',
            sessionPath: '/Users/copizza/Desktop/happyhere/recovered-project',
            sessionTag: 'team:team-1:member:member-1',
            executionPlane: 'mainline',
            specId: 'spec-1',
            parentSessionId: 'parent-1',
            env: {
                AHA_TEAM_MEMBER_ID: 'member-1',
                AHA_AGENT_PROMPT: 'Keep going',
            },
        });
    });

    it('backfills respawn options from webhook metadata for recovered sessions', () => {
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
            path: '/Users/copizza/Desktop/happyhere/project-b',
            host: 'test-host',
            homeDir: '/Users/copizza',
            ahaHomeDir: '/Users/copizza/.aha',
            ahaLibDir: '/Users/copizza/Desktop/happyhere/aha-cli-bug-fix-0324',
            ahaToolsDir: '/Users/copizza/Desktop/happyhere/aha-cli-bug-fix-0324/tools/unpacked',
            hostPid: 12345,
            teamId: 'team-1',
            roomId: 'team-1',
            role: 'builder',
            executionPlane: 'mainline',
            memberId: 'member-1',
            sessionTag: 'team:team-1:member:member-1',
            flavor: 'codex',
            name: 'Builder 1',
        } as any);

        expect(pidToTrackedSession.get(12345)?.spawnOptions).toMatchObject({
            directory: '/Users/copizza/Desktop/happyhere/project-b',
            agent: 'codex',
            teamId: 'team-1',
            role: 'builder',
            sessionName: 'Builder 1',
            sessionPath: '/Users/copizza/Desktop/happyhere/project-b',
            sessionTag: 'team:team-1:member:member-1',
            executionPlane: 'mainline',
            env: {
                AHA_TEAM_MEMBER_ID: 'member-1',
            },
        });
    });

    it('infers recovered codex runtimes from process args so they do not consume Claude slots', async () => {
        process.env.AHA_MAX_CONCURRENT_CLAUDE_AGENTS = '3';
        mockExecSync.mockImplementation((command: string) => {
            if (command.startsWith('ps -eo pid,args')) {
                return [
                    '2112 node /cli/index.mjs claude --aha-starting-mode remote --started-by daemon --session-tag team:team-1:member:member-1',
                    '3655 node /cli/index.mjs codex --aha-starting-mode remote --started-by daemon --session-tag team:team-1:member:member-2',
                    '3674 node /cli/index.mjs codex --aha-starting-mode remote --started-by daemon --session-tag team:team-1:member:member-3',
                    '4620 node /cli/index.mjs codex --aha-starting-mode remote --started-by daemon --session-tag team:team-1:member:member-4',
                ].join('\n');
            }
            if (command.startsWith('lsof -a -d cwd -Fn -p ')) {
                return 'p12345\nn/Users/copizza/Desktop/happyhere/recovered-project\n';
            }
            if (command.startsWith('git rev-parse')) return 'true\n';
            if (command.startsWith('git status --porcelain')) return '';
            throw new Error(`Unexpected execSync command: ${command}`);
        });

        mockSpawnAhaCLI.mockReturnValue({
            pid: 54321,
            on: vi.fn(),
            stdout: undefined,
            stderr: undefined,
        });

        const api = {
            getTeam: vi.fn().mockResolvedValue({
                team: {
                    members: [],
                },
            }),
        };

        const recovered = await recoverExistingSessions(api as any);

        expect(recovered).toBe(4);
        expect(pidToTrackedSession.get(3655)?.spawnOptions?.agent).toBe('codex');
        expect(pidToTrackedSession.get(3655)?.ahaSessionMetadataFromLocalWebhook?.flavor).toBe('codex');
        expect(pidToTrackedSession.get(2112)?.spawnOptions?.agent).toBe('claude');

        const spawnPromise = spawnSession({
            directory: process.cwd(),
            agent: 'claude',
            teamId: 'team-2',
            role: 'builder',
            sessionName: 'Builder 2',
            sessionTag: 'team:team-2:member:member-5',
            sessionPath: process.cwd(),
            env: {
                AHA_TEAM_MEMBER_ID: 'member-5',
            },
        });

        await vi.waitFor(() => {
            expect(mockSpawnAhaCLI).toHaveBeenCalledTimes(1);
        });

        onAhaSessionWebhook('cmn-new-session', {
            path: process.cwd(),
            host: 'test-host',
            homeDir: '/Users/copizza',
            ahaHomeDir: '/Users/copizza/.aha',
            ahaLibDir: '/Users/copizza/Desktop/happyhere/aha-cli-bug-fix-0324',
            ahaToolsDir: '/Users/copizza/Desktop/happyhere/aha-cli-bug-fix-0324/tools/unpacked',
            hostPid: 54321,
            teamId: 'team-2',
            roomId: 'team-2',
            role: 'builder',
            executionPlane: 'mainline',
            memberId: 'member-5',
            sessionTag: 'team:team-2:member:member-5',
            flavor: 'claude',
            name: 'Builder 2',
        } as any);

        await expect(spawnPromise).resolves.toEqual({
            type: 'success',
            sessionId: 'cmn-new-session',
        });
    });

    it('returns queued immediately with a reserved session id when Claude capacity is full', async () => {
        process.env.AHA_MAX_CONCURRENT_CLAUDE_AGENTS = '3';
        mockSpawnAhaCLI.mockReturnValue({
            pid: 65432,
            on: vi.fn(),
            stdout: undefined,
            stderr: undefined,
        });

        pidToTrackedSession.set(1001, {
            startedBy: 'daemon',
            pid: 1001,
            ahaSessionId: 'cmn-claude-1',
            spawnOptions: { directory: process.cwd(), agent: 'claude' },
        });
        pidToTrackedSession.set(1002, {
            startedBy: 'daemon',
            pid: 1002,
            ahaSessionId: 'cmn-claude-2',
            spawnOptions: { directory: process.cwd(), agent: 'claude' },
        });
        pidToTrackedSession.set(1003, {
            startedBy: 'daemon',
            pid: 1003,
            ahaSessionId: 'cmn-claude-3',
            spawnOptions: { directory: process.cwd(), agent: 'claude' },
        });

        const queued = await spawnSession({
            directory: process.cwd(),
            agent: 'claude',
            teamId: 'team-queue',
            role: 'builder',
            sessionName: 'Queued Builder',
            sessionTag: 'team:team-queue:member:member-queued',
            sessionPath: process.cwd(),
            env: {
                AHA_TEAM_MEMBER_ID: 'member-queued',
            },
        });

        expect(queued.type).toBe('queued');
        if (queued.type !== 'queued') {
            throw new Error(`Expected queued spawn result, got ${queued.type}`);
        }
        expect(queued.sessionId).toMatch(/^queued-/);
        expect(queued.queuePosition).toBe(1);
        expect(mockSpawnAhaCLI).not.toHaveBeenCalled();

        pidToTrackedSession.delete(1001);
        onHeartbeatPrunedSession({
            startedBy: 'daemon',
            pid: 1001,
            ahaSessionId: 'cmn-claude-1',
            intentionallyStopped: true,
            spawnOptions: { directory: process.cwd(), agent: 'claude' },
        });

        await vi.waitFor(() => {
            expect(mockSpawnAhaCLI).toHaveBeenCalledTimes(1);
        });
        const spawnArgs = mockSpawnAhaCLI.mock.calls[0][1];
        expect(spawnArgs.env.AHA_RECOVER_SESSION_ID).toBe(queued.sessionId);
    });

    it('respawns automatically after abnormal exit once respawn options are available', async () => {
        vi.useFakeTimers();

        mockSpawnAhaCLI.mockReturnValue({
            pid: 54321,
            on: vi.fn(),
            stdout: undefined,
            stderr: undefined,
        });

        pidToTrackedSession.set(12345, {
            startedBy: 'daemon',
            pid: 12345,
            ahaSessionId: 'cmn-old-session',
            spawnOptions: {
                directory: process.cwd(),
                agent: 'claude',
                teamId: 'team-1',
                role: 'builder',
                sessionName: 'Builder 1',
                sessionTag: 'team:team-1:member:member-1',
                sessionPath: process.cwd(),
                executionPlane: 'mainline',
                env: {
                    AHA_TEAM_MEMBER_ID: 'member-1',
                },
            },
            respawnCount: 0,
        });

        onChildExited(12345);
        await vi.advanceTimersByTimeAsync(5000);
        await vi.waitFor(() => {
            expect(mockSpawnAhaCLI).toHaveBeenCalledTimes(1);
        });

        onAhaSessionWebhook('cmn-new-session', {
            path: process.cwd(),
            host: 'test-host',
            homeDir: '/Users/copizza',
            ahaHomeDir: '/Users/copizza/.aha',
            ahaLibDir: '/Users/copizza/Desktop/happyhere/aha-cli-bug-fix-0324',
            ahaToolsDir: '/Users/copizza/Desktop/happyhere/aha-cli-bug-fix-0324/tools/unpacked',
            hostPid: 54321,
            teamId: 'team-1',
            roomId: 'team-1',
            role: 'builder',
            executionPlane: 'mainline',
            memberId: 'member-1',
            sessionTag: 'team:team-1:member:member-1',
            flavor: 'claude',
            name: 'Builder 1',
        } as any);

        expect(pidToTrackedSession.get(54321)?.ahaSessionId).toBe('cmn-new-session');
        expect(pidToTrackedSession.get(54321)?.respawnCount).toBe(1);

        vi.useRealTimers();
    });
});
