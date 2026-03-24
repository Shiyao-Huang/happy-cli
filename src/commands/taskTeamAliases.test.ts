import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApi = vi.hoisted(() => ({
  completeTask: vi.fn(),
  getTeam: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => mockApi),
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(async () => ({ token: 'token' })),
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(async () => ({ credentials: { token: 'token' } })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import { handleTasksCommand, showTasksHelp } from './tasks';
import { handleTeamsCommand, showTeamsHelp, summarizeTasksByStatus } from './teams';

describe('task/team CLI aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AHA_ROOM_ID;
  });

  it('routes task done to completeTask', async () => {
    mockApi.completeTask.mockResolvedValue({
      success: true,
      task: {
        id: 'task-1',
        status: 'done',
        priority: 'high',
        title: 'Ship it',
        assigneeId: 'sess-1',
      },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleTasksCommand(['done', 'task-1', '--team', 'team-1', '--session', 'sess-1']);

    expect(mockApi.completeTask).toHaveBeenCalledWith('team-1', 'task-1', 'sess-1');
    expect(logSpy).toHaveBeenCalled();
  });

  it('shows team status using explicit team id', async () => {
    mockApi.getTeam.mockResolvedValue({
      team: {
        id: 'team-1',
        name: 'Sprint Crew',
        memberCount: 2,
        taskCount: 3,
        members: [],
        createdAt: 0,
        updatedAt: 0,
      },
    });
    mockApi.listTasks.mockResolvedValue({
      tasks: [
        { id: 'todo-1', title: 'Todo', status: 'todo', priority: 'medium' },
        { id: 'doing-1', title: 'Doing', status: 'in-progress', priority: 'high' },
        { id: 'done-1', title: 'Done', status: 'done', priority: 'low' },
      ],
      version: 1,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleTeamsCommand(['status', 'team-1']);

    expect(mockApi.getTeam).toHaveBeenCalledWith('team-1');
    expect(mockApi.listTasks).toHaveBeenCalledWith('team-1');

    const output = logSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).toContain('Team status for team-1');
    expect(output).toContain('Task summary');
    expect(output).toContain('Open tasks (2)');
  });

  it('falls back to AHA_ROOM_ID for team status', async () => {
    process.env.AHA_ROOM_ID = 'team-from-env';
    mockApi.getTeam.mockResolvedValue({
      team: {
        id: 'team-from-env',
        name: 'Env Team',
        memberCount: 0,
        taskCount: 0,
        members: [],
        createdAt: 0,
        updatedAt: 0,
      },
    });
    mockApi.listTasks.mockResolvedValue({ tasks: [], version: 1 });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleTeamsCommand(['status']);

    expect(mockApi.getTeam).toHaveBeenCalledWith('team-from-env');
    expect(logSpy).toHaveBeenCalled();
  });

  it('summarizes tasks by status', () => {
    expect(summarizeTasksByStatus([
      { status: 'todo' },
      { status: 'in-progress' },
      { status: 'done' },
      { status: 'done' },
      { status: 'unexpected' },
    ])).toEqual({
      total: 5,
      byStatus: {
        todo: 2,
        'in-progress': 1,
        review: 0,
        blocked: 0,
        done: 2,
      },
    });
  });

  it('documents done/status aliases in help output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    showTasksHelp();
    showTeamsHelp();

    const output = logSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).toContain('done');
    expect(output).toContain('status');
    expect(output).toContain('aha task');
    expect(output).toContain('aha team');
  });
});
