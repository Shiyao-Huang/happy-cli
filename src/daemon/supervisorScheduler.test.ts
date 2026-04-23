import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAxiosGet = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
    debug: vi.fn(),
}));
const mockConfiguration = vi.hoisted(() => ({
    serverUrl: 'https://server.test',
    ahaHomeDir: '/tmp/aha-test',
}));
const mockListSupervisorStates = vi.hoisted(() => vi.fn());
const mockReadSupervisorState = vi.hoisted(() => vi.fn());
const mockUpdateSupervisorState = vi.hoisted(() => vi.fn());
const mockUpdateSupervisorRun = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
    default: {
        get: mockAxiosGet,
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: mockLogger,
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

vi.mock('./supervisorState', () => ({
    getPendingActionRetryDelayMs: (retryCount: number, baseMs = 60_000) => baseMs * (2 ** Math.max(0, retryCount)),
    listSupervisorStates: mockListSupervisorStates,
    readSupervisorState: mockReadSupervisorState,
    SUPERVISOR_PENDING_ACTION_MAX_RETRIES: 3,
    updateSupervisorRun: mockUpdateSupervisorRun,
    updateSupervisorState: mockUpdateSupervisorState,
}));

import { runSupervisorCycle } from './supervisorScheduler';

describe('supervisorScheduler', () => {
    beforeEach(() => {
        mockAxiosGet.mockReset();
        mockLogger.debug.mockReset();
        mockListSupervisorStates.mockReset();
        mockReadSupervisorState.mockReset();
        mockUpdateSupervisorState.mockReset();
        mockUpdateSupervisorRun.mockReset();
        delete process.env.AHA_SUPERVISOR_SCAN_ALL_TEAMS;
        delete process.env.AHA_SUPERVISOR_SCAN_IDLE_STATES;

        mockListSupervisorStates.mockReturnValue([]);
        mockReadSupervisorState.mockImplementation((teamId: string) => ({
            teamId,
            lastRunAt: 0,
            teamLogCursor: 0,
            ccLogCursors: {},
            codexHistoryCursor: 0,
            codexSessionCursors: {},
            lastConclusion: '',
            lastSessionId: null,
            terminated: false,
            idleRuns: 0,
            lastSupervisorPid: 0,
            pendingAction: null,
            pendingActionMeta: null,
        }));
        mockUpdateSupervisorState.mockImplementation(async (_teamId: string, updater: (state: any) => any) => updater(mockReadSupervisorState('team-1')));
        mockUpdateSupervisorRun.mockResolvedValue(mockReadSupervisorState('team-1'));
    });

    it('spawns a supervisor for teams with unfinished tasks even when no live mainline agent remains', async () => {
        process.env.AHA_SUPERVISOR_SCAN_ALL_TEAMS = '1';
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url === 'https://server.test/v1/teams') {
                return {
                    data: {
                        teams: [{ id: 'team-1', taskCount: 2 }],
                    },
                };
            }

            if (url === 'https://server.test/v1/teams/team-1/tasks') {
                return {
                    data: {
                        tasks: [
                            { id: 'task-1', status: 'todo' },
                            { id: 'task-2', status: 'done' },
                        ],
                    },
                };
            }

            if (url.includes('/genomes/%40official/supervisor')) {
                return {
                    data: {
                        genome: { id: 'spec-supervisor' },
                    },
                };
            }

            throw new Error(`Unexpected axios.get call: ${url}`);
        });

        const spawnSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'supervisor-session-1',
        });

        await runSupervisorCycle({
            pidToTrackedSession: new Map(),
            heartbeatCount: 20,
            supervisorInterval: 20,
            supervisorTerminateIdleMs: 60_000,
            pendingActionBaseRetryMs: 60_000,
            heartbeatIntervalMs: 3_000,
            credentialsToken: 'token-1',
            spawnSession,
            requestHelp: vi.fn(),
        });

        expect(spawnSession).toHaveBeenCalledTimes(1);
        expect(spawnSession).toHaveBeenCalledWith(
            expect.objectContaining({
                teamId: 'team-1',
                role: 'supervisor',
                executionPlane: 'bypass',
                specId: '@official/supervisor',
            })
        );
    });

    it('does not scan every historical team by default', async () => {
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url === 'https://server.test/v1/teams') {
                return {
                    data: {
                        teams: [{ id: 'team-1', taskCount: 2 }],
                    },
                };
            }
            throw new Error(`Unexpected axios.get call: ${url}`);
        });

        const spawnSession = vi.fn();

        await runSupervisorCycle({
            pidToTrackedSession: new Map(),
            heartbeatCount: 20,
            supervisorInterval: 20,
            supervisorTerminateIdleMs: 60_000,
            pendingActionBaseRetryMs: 60_000,
            heartbeatIntervalMs: 3_000,
            credentialsToken: 'token-1',
            spawnSession,
            requestHelp: vi.fn(),
        });

        expect(mockAxiosGet).not.toHaveBeenCalledWith(
            'https://server.test/v1/teams',
            expect.anything(),
        );
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('spawns for a local pending supervisor state without all-team scanning', async () => {
        const pendingState = {
            teamId: 'team-1',
            lastRunAt: 0,
            teamLogCursor: 0,
            ccLogCursors: {},
            codexHistoryCursor: 0,
            codexSessionCursors: {},
            lastConclusion: '',
            lastSessionId: null,
            terminated: false,
            idleRuns: 0,
            lastSupervisorPid: 0,
            pendingAction: {
                type: 'notify_help',
                message: 'team stalled',
            },
            pendingActionMeta: null,
        };
        mockListSupervisorStates.mockReturnValue([pendingState]);
        mockReadSupervisorState.mockReturnValue(pendingState);
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url === 'https://server.test/v1/teams/team-1/tasks') {
                return {
                    data: {
                        tasks: [{ id: 'task-1', status: 'todo' }],
                    },
                };
            }

            if (url.includes('/genomes/%40official/supervisor')) {
                return {
                    data: {
                        genome: { id: 'spec-supervisor' },
                    },
                };
            }

            throw new Error(`Unexpected axios.get call: ${url}`);
        });

        const spawnSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'supervisor-session-1',
        });

        await runSupervisorCycle({
            pidToTrackedSession: new Map(),
            heartbeatCount: 20,
            supervisorInterval: 20,
            supervisorTerminateIdleMs: 60_000,
            pendingActionBaseRetryMs: 60_000,
            heartbeatIntervalMs: 3_000,
            credentialsToken: 'token-1',
            spawnSession,
            requestHelp: vi.fn(),
        });

        expect(spawnSession).toHaveBeenCalledTimes(1);
        expect(spawnSession).toHaveBeenCalledWith(
            expect.objectContaining({
                teamId: 'team-1',
                role: 'supervisor',
                specId: '@official/supervisor',
            })
        );
    });

    it('does not revive conditional escalation states by default', async () => {
        const conditionalState = {
            teamId: 'team-1',
            lastRunAt: 0,
            teamLogCursor: 0,
            ccLogCursors: {},
            codexHistoryCursor: 0,
            codexSessionCursors: {},
            lastConclusion: '',
            lastSessionId: null,
            terminated: false,
            idleRuns: 0,
            lastSupervisorPid: 0,
            pendingAction: {
                type: 'conditional_escalation',
                condition: 'daemon still down',
                action: 'notify human',
                deadline: Date.now() - 1000,
            },
            pendingActionMeta: null,
        };
        mockListSupervisorStates.mockReturnValue([conditionalState]);
        mockReadSupervisorState.mockReturnValue(conditionalState);

        const spawnSession = vi.fn();

        await runSupervisorCycle({
            pidToTrackedSession: new Map(),
            heartbeatCount: 20,
            supervisorInterval: 20,
            supervisorTerminateIdleMs: 60_000,
            pendingActionBaseRetryMs: 60_000,
            heartbeatIntervalMs: 3_000,
            credentialsToken: 'token-1',
            spawnSession,
            requestHelp: vi.fn(),
        });

        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('does not spawn a duplicate supervisor when one is already tracked live', async () => {
        const pendingState = {
            teamId: 'team-1',
            lastRunAt: 0,
            teamLogCursor: 0,
            ccLogCursors: {},
            codexHistoryCursor: 0,
            codexSessionCursors: {},
            lastConclusion: '',
            lastSessionId: null,
            terminated: false,
            idleRuns: 0,
            lastSupervisorPid: 0,
            pendingAction: {
                type: 'notify_help',
                message: 'team stalled',
            },
            pendingActionMeta: null,
        };
        mockListSupervisorStates.mockReturnValue([pendingState]);
        mockReadSupervisorState.mockReturnValue(pendingState);
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url === 'https://server.test/v1/teams/team-1/tasks') {
                return {
                    data: {
                        tasks: [{ id: 'task-1', status: 'todo' }],
                    },
                };
            }
            throw new Error(`Unexpected axios.get call: ${url}`);
        });

        const spawnSession = vi.fn();

        await runSupervisorCycle({
            pidToTrackedSession: new Map([
                [process.pid, {
                    startedBy: 'daemon',
                    ahaSessionId: 'supervisor-session',
                    pid: process.pid,
                    ahaSessionMetadataFromLocalWebhook: {
                        teamId: 'team-1',
                        role: 'supervisor',
                        executionPlane: 'bypass',
                    } as any,
                }],
            ]),
            heartbeatCount: 20,
            supervisorInterval: 20,
            supervisorTerminateIdleMs: 60_000,
            pendingActionBaseRetryMs: 60_000,
            heartbeatIntervalMs: 3_000,
            credentialsToken: 'token-1',
            spawnSession,
            requestHelp: vi.fn(),
        });

        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('respawns when the persisted supervisor PID is alive but MCP heartbeat marks it dead', async () => {
        const zombieState = {
            teamId: 'team-1',
            lastRunAt: 0,
            teamLogCursor: 0,
            ccLogCursors: {},
            codexHistoryCursor: 0,
            codexSessionCursors: {},
            lastConclusion: '',
            lastSessionId: 'supervisor-session-dead',
            terminated: false,
            idleRuns: 0,
            lastSupervisorPid: 22222,
            pendingAction: null,
            pendingActionMeta: null,
        };
        mockReadSupervisorState.mockReturnValue(zombieState);
        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url === 'https://server.test/v1/teams/team-1/tasks') {
                return {
                    data: {
                        tasks: [],
                    },
                };
            }

            if (url.includes('/genomes/%40official/supervisor')) {
                return {
                    data: {
                        genome: { id: 'spec-supervisor' },
                    },
                };
            }

            throw new Error(`Unexpected axios.get call: ${url}`);
        });

        const spawnSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'supervisor-session-new',
        });
        const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

        try {
            await runSupervisorCycle({
                pidToTrackedSession: new Map([
                    [11, {
                        pid: 11,
                        ahaSessionId: 'mainline-session',
                        ahaSessionMetadataFromLocalWebhook: {
                            teamId: 'team-1',
                            role: 'implementer',
                            executionPlane: 'mainline',
                            path: '/repo',
                        },
                    } as any],
                    [22222, {
                        pid: 22222,
                        ahaSessionId: 'supervisor-session-dead',
                        ahaSessionMetadataFromLocalWebhook: {
                            teamId: 'team-1',
                            role: 'supervisor',
                            executionPlane: 'bypass',
                        },
                    } as any],
                ]),
                teamHeartbeats: new Map([
                    ['team-1', {
                        getDeadAgents: () => [{
                            agentId: 'supervisor-session-dead',
                            role: 'supervisor',
                            lastSeen: Date.now() - 120_000,
                            orphanedTasks: [],
                            deadForMs: 120_000,
                        }],
                    } as any],
                ]),
                heartbeatCount: 20,
                supervisorInterval: 20,
                supervisorTerminateIdleMs: 60_000,
                pendingActionBaseRetryMs: 60_000,
                heartbeatIntervalMs: 3_000,
                credentialsToken: 'token-1',
                spawnSession,
                requestHelp: vi.fn(),
            });

            expect(processKill).toHaveBeenCalledWith(22222, 'SIGTERM');
        } finally {
            processKill.mockRestore();
        }

        expect(mockUpdateSupervisorRun).toHaveBeenCalledWith('team-1', { lastSupervisorPid: 0 });
        expect(spawnSession).toHaveBeenCalledTimes(1);
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            teamId: 'team-1',
            role: 'supervisor',
            executionPlane: 'bypass',
        }));
    });

    it('does not terminate a team when task summary lookup fails', async () => {
        const staleState = {
            teamId: 'team-1',
            lastRunAt: Date.now() - 120_000,
            teamLogCursor: 0,
            ccLogCursors: {},
            codexHistoryCursor: 0,
            codexSessionCursors: {},
            lastConclusion: '',
            lastSessionId: null,
            terminated: false,
            idleRuns: 0,
            lastSupervisorPid: 0,
            pendingAction: null,
            pendingActionMeta: null,
        };

        mockListSupervisorStates.mockReturnValue([staleState]);
        mockReadSupervisorState.mockReturnValue(staleState);
        mockAxiosGet.mockRejectedValue(new Error('tasks api unavailable'));

        await runSupervisorCycle({
            pidToTrackedSession: new Map(),
            heartbeatCount: 1,
            supervisorInterval: 20,
            supervisorTerminateIdleMs: 60_000,
            pendingActionBaseRetryMs: 60_000,
            heartbeatIntervalMs: 3_000,
            credentialsToken: 'token-1',
            spawnSession: vi.fn(),
            requestHelp: vi.fn(),
        });

        expect(mockUpdateSupervisorState).not.toHaveBeenCalledWith(
            'team-1',
            expect.any(Function),
        );
    });

    it('keeps pendingAction when help reuse is saturated and schedules another retry', async () => {
        const now = Date.now();
        const pendingState = {
            teamId: 'team-1',
            lastRunAt: now - 120_000,
            teamLogCursor: 0,
            ccLogCursors: {},
            codexHistoryCursor: 0,
            codexSessionCursors: {},
            lastConclusion: '',
            lastSessionId: null,
            terminated: false,
            idleRuns: 0,
            lastSupervisorPid: 0,
            pendingAction: {
                type: 'notify_help',
                message: 'help needed',
                requestType: 'error',
                severity: 'high',
                description: 'builder is blocked',
                targetSessionId: 'session-1',
            },
            pendingActionMeta: {
                retryCount: 0,
                lastAttemptAt: 0,
                nextRetryAt: 0,
                lastError: null,
            },
        };

        mockListSupervisorStates.mockReturnValue([pendingState]);
        mockReadSupervisorState.mockReturnValue(pendingState);
        mockAxiosGet.mockRejectedValue(new Error('tasks api unavailable'));

        const requestHelp = vi.fn().mockResolvedValue({
            success: true,
            helpAgentSessionId: 'help-1',
            reused: true,
            saturated: true,
        });

        await runSupervisorCycle({
            pidToTrackedSession: new Map([
                [11, {
                    pid: 11,
                    ahaSessionId: 'session-1',
                    ahaSessionMetadataFromLocalWebhook: {
                        teamId: 'team-1',
                        role: 'builder',
                        path: '/repo',
                        host: 'h',
                        homeDir: '/home',
                        ahaHomeDir: '/aha',
                        ahaLibDir: '/lib',
                        ahaToolsDir: '/tools',
                    },
                } as any],
            ]),
            heartbeatCount: 1,
            supervisorInterval: 20,
            supervisorTerminateIdleMs: 60_000,
            pendingActionBaseRetryMs: 60_000,
            heartbeatIntervalMs: 3_000,
            credentialsToken: 'token-1',
            spawnSession: vi.fn(),
            requestHelp,
        });

        expect(requestHelp).toHaveBeenCalledTimes(1);
        expect(mockUpdateSupervisorState).toHaveBeenCalledWith(
            'team-1',
            expect.any(Function),
        );

        const updater = mockUpdateSupervisorState.mock.calls.at(-1)?.[1];
        const nextState = updater ? updater(pendingState) : null;
        expect(nextState?.pendingAction).toEqual(pendingState.pendingAction);
        expect(nextState?.pendingActionMeta?.retryCount).toBe(1);
        expect(nextState?.pendingActionMeta?.lastError).toContain('saturated');
    });
});
