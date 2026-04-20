import { describe, expect, it } from 'vitest';
import {
    buildShowAllTaskPage,
    resolveCreateTaskPolicy,
    resolveTaskActorSessionId,
    summarizeTaskForList,
} from './taskTools';

describe('resolveCreateTaskPolicy', () => {
    it('allows coordinator roles to create standard tasks with assignees', () => {
        const result = resolveCreateTaskPolicy({
            role: 'master',
            effectiveGenome: null,
            requestedType: 'standard',
            requestedAssigneeId: 'sess-1',
        });

        expect(result).toEqual({
            allowed: true,
            taskType: 'standard',
            assigneeId: 'sess-1',
        });
    });

    it('denies regular task creation for non-coordinator worker roles', () => {
        const result = resolveCreateTaskPolicy({
            role: 'implementer',
            effectiveGenome: null,
            requestedType: 'standard',
        });

        expect(result.allowed).toBe(false);
        expect(result.taskType).toBe('standard');
        expect(result.denyMessage).toContain('cannot create team tasks');
        expect(result.denyMessage).toContain('type="hypothesis"');
    });

    it('allows worker roles to create unassigned hypothesis tasks', () => {
        const result = resolveCreateTaskPolicy({
            role: 'implementer',
            effectiveGenome: null,
            requestedType: 'hypothesis',
        });

        expect(result).toEqual({
            allowed: true,
            taskType: 'hypothesis',
            assigneeId: null,
            labels: ['hypothesis'],
        });
    });

    it('rejects assigneeId on hypothesis tasks even for coordinators', () => {
        const result = resolveCreateTaskPolicy({
            role: 'master',
            effectiveGenome: null,
            requestedType: 'hypothesis',
            requestedAssigneeId: 'sess-2',
        });

        expect(result.allowed).toBe(false);
        expect(result.taskType).toBe('hypothesis');
        expect(result.denyMessage).toContain('must be unassigned');
    });

    it('still honors explicit task.create authority for standard tasks', () => {
        const result = resolveCreateTaskPolicy({
            role: 'implementer',
            effectiveGenome: { authorities: ['task.create'] },
            requestedType: 'standard',
        });

        expect(result).toEqual({
            allowed: true,
            taskType: 'standard',
            assigneeId: null,
        });
    });
});

describe('summarizeTaskForList', () => {
    it('keeps only compact fields needed for list views', () => {
        const summary = summarizeTaskForList({
            id: 'task-1',
            title: 'Fix scope noise',
            status: 'review',
            priority: 'high',
            assigneeId: 'session-1',
            reporterId: null,
            parentTaskId: 'parent-1',
            approvalStatus: 'pending',
            labels: ['scope', 'repo', 1 as any],
            updatedAt: 123,
            createdAt: 100,
            depth: 2,
            comments: [{}, {}],
            blockers: [{}],
            acceptanceCriteria: ['a', 'b'],
            subtaskIds: ['sub-1'],
        });

        expect(summary).toEqual({
            id: 'task-1',
            title: 'Fix scope noise',
            status: 'review',
            priority: 'high',
            assigneeId: 'session-1',
            reporterId: null,
            parentTaskId: 'parent-1',
            approvalStatus: 'pending',
            labels: ['scope', 'repo'],
            depth: 2,
            updatedAt: 123,
            createdAt: 100,
            commentCount: 2,
            blockerCount: 1,
            acceptanceCriteriaCount: 2,
            subtaskCount: 1,
        });
    });
});

describe('buildShowAllTaskPage', () => {
    const tasks = Array.from({ length: 4 }, (_, index) => ({
        id: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        status: index % 2 === 0 ? 'todo' : 'review',
        comments: Array.from({ length: index }, () => ({ content: 'x'.repeat(1000) })),
        blockers: [],
        acceptanceCriteria: [],
        subtaskIds: [],
    }));

    it('returns compact board summaries instead of raw full tasks', () => {
        const result = buildShowAllTaskPage({
            tasks,
            teamStats: { totalTasks: 4 },
            pendingApprovals: [{
                id: 'task-2',
                title: 'Task 2',
                status: 'review',
                comments: [{}, {}],
            }],
        }) as any;

        expect(result.mode).toBe('board-overview');
        expect(result.teamStats).toEqual({ totalTasks: 4 });
        expect(result.pendingApprovals).toEqual([{
            id: 'task-2',
            title: 'Task 2',
            status: 'review',
            priority: null,
            assigneeId: null,
            reporterId: null,
            parentTaskId: null,
            approvalStatus: null,
            labels: [],
            depth: 0,
            updatedAt: null,
            createdAt: null,
            commentCount: 2,
            blockerCount: 0,
            acceptanceCriteriaCount: 0,
            subtaskCount: 0,
        }]);
        expect(result.boardOverview).toMatchObject({
            totalBoardTasks: 4,
            matchingTasks: 4,
            returnedTasks: 4,
            pendingApprovalCount: 1,
        });
        expect(result.allTasks).toHaveLength(4);
        expect(result.allTasks[1]).toMatchObject({ id: 'task-2', commentCount: 1 });
        expect(result.allTasks[1]).not.toHaveProperty('comments');
        expect(result.guidance.details).toContain('get_task');
    });

    it('keeps status filtering while staying compact', () => {
        const result = buildShowAllTaskPage({
            tasks,
            status: 'review',
        }) as any;

        expect(result.filters).toEqual({ status: 'review' });
        expect(result.boardOverview).toMatchObject({
            totalBoardTasks: 4,
            matchingTasks: 2,
            returnedTasks: 2,
            pendingApprovalCount: 0,
            statusCounts: {
                todo: 0,
                'in-progress': 0,
                review: 2,
                blocked: 0,
                done: 0,
            },
        });
        expect(result.allTasks).toHaveLength(2);
        expect(result.allTasks.every((task: any) => task.status === 'review')).toBe(true);
    });
});

describe('resolveTaskActorSessionId', () => {
    it('prefers metadata.ahaSessionId when present', () => {
        expect(resolveTaskActorSessionId({ ahaSessionId: 'server-sid' }, 'local-sid')).toBe('server-sid');
    });

    it('falls back to client session id when ahaSessionId is empty or whitespace', () => {
        expect(resolveTaskActorSessionId({ ahaSessionId: '' }, 'local-sid')).toBe('local-sid');
        expect(resolveTaskActorSessionId({ ahaSessionId: '   ' }, 'local-sid')).toBe('local-sid');
    });

    it('falls back to client session id when metadata is missing', () => {
        expect(resolveTaskActorSessionId({}, 'local-sid')).toBe('local-sid');
        expect(resolveTaskActorSessionId(null, 'local-sid')).toBe('local-sid');
        expect(resolveTaskActorSessionId(undefined, 'local-sid')).toBe('local-sid');
    });
});
