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
                specId: 'spec-supervisor',
            })
        );
    });
});
