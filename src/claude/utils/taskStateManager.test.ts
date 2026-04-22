import { describe, expect, it, vi } from 'vitest';

import { TaskStateManager } from './taskStateManager';

describe('TaskStateManager team initialization', () => {
    it('repairs missing teams through the Team API before listing tasks', async () => {
        const api = {
            getArtifact: vi.fn().mockRejectedValue(new Error('Request failed with status code 404')),
            createTeam: vi.fn().mockResolvedValue({
                team: {
                    id: 'team-1',
                    name: 'Team team-1',
                    memberCount: 0,
                    taskCount: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            }),
            listTasks: vi.fn().mockResolvedValue({ tasks: [], version: 1 }),
        };

        const manager = new TaskStateManager(api as any, 'team-1', 'session-1', 'org-manager');
        const board = await manager.getBoard();

        expect(api.createTeam).toHaveBeenCalledWith({
            id: 'team-1',
            name: 'Team team-1',
            board: expect.objectContaining({
                tasks: [],
                team: expect.objectContaining({
                    name: 'Team team-1',
                    members: [],
                }),
            }),
        });
        expect(api.listTasks).toHaveBeenCalledWith('team-1', undefined);
        expect(board.tasks).toEqual([]);
    });

    it('fails fast when the server cannot create the requested team id', async () => {
        const api = {
            getArtifact: vi.fn().mockRejectedValue(new Error('Request failed with status code 404')),
            createTeam: vi.fn().mockResolvedValue({
                team: {
                    id: 'fallback-team',
                    name: 'Fallback',
                    memberCount: 0,
                    taskCount: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            }),
            listTasks: vi.fn(),
        };

        const manager = new TaskStateManager(api as any, 'team-1', 'session-1', 'org-manager');

        await expect(manager.getBoard()).rejects.toThrow('fallback team fallback-team');
        expect(api.listTasks).not.toHaveBeenCalled();
    });
});
