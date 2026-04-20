/**
 * @module taskTools
 * @description MCP tool registrations for kanban task lifecycle.
 *
 * ```mermaid
 * graph LR
 *   A[taskTools] -->|ctx.mcp| B[McpServer]
 *   A -->|ctx.taskManager| C[TaskStateManager]
 *   A -->|ctx.api| D[ApiClient]
 *   A -->|ctx.client| E[ApiSessionClient]
 * ```
 *
 * ## Tools registered
 * - create_task, update_task, add_task_comment, delete_task
 * - list_tasks, get_task, create_subtask, list_subtasks
 * - start_task, complete_task, report_blocker, resolve_blocker
 *
 * ## Design
 * - All tools share McpToolContext (see mcpContext.ts)
 * - Task state mutations go through TaskStateManager
 * - Team messages sent via ctx.api.sendTeamMessage()
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import {
    canCreateTeamTasks,
    canManageExistingTasks,
    hasTeamAuthority,
} from '@/claude/team/roles';
import { emitTraceEvent } from '@/trace/traceEmitter';
import { TraceEventKind } from '@/trace/traceTypes';
import { McpToolContext } from './mcpContext';

export type CreateTaskType = 'standard' | 'hypothesis';

interface CreateTaskPolicyArgs {
    role?: string;
    effectiveGenome?: any;
    requestedType?: CreateTaskType;
    requestedAssigneeId?: string;
}

interface CreateTaskPolicyResult {
    allowed: boolean;
    taskType: CreateTaskType;
    assigneeId: string | null;
    labels?: string[];
    denyMessage?: string;
}

type ListableTask = {
    id: string;
    title?: string;
    status?: string;
    priority?: string | null;
    assigneeId?: string | null;
    reporterId?: string | null;
    parentTaskId?: string | null;
    approvalStatus?: string | null;
    labels?: unknown[];
    updatedAt?: number;
    createdAt?: number;
    comments?: unknown[];
    blockers?: unknown[];
    acceptanceCriteria?: unknown[];
    subtaskIds?: unknown[];
    depth?: number;
};

interface ShowAllTaskPageArgs {
    tasks: ListableTask[];
    status?: string;
    cursor?: number;
    limit?: number;
    teamStats?: unknown;
    pendingApprovals?: ListableTask[] | unknown;
}

export function resolveCreateTaskPolicy(args: CreateTaskPolicyArgs): CreateTaskPolicyResult {
    const taskType: CreateTaskType = args.requestedType === 'hypothesis' ? 'hypothesis' : 'standard';
    const hasFullTaskCreate = canCreateTeamTasks(args.role, args.effectiveGenome);

    if (taskType === 'hypothesis') {
        if (args.requestedAssigneeId) {
            return {
                allowed: false,
                taskType,
                assigneeId: null,
                denyMessage: 'Error: Hypothesis tasks are capture-only and must be unassigned. Remove assigneeId and let a coordinator triage later.',
            };
        }

        return {
            allowed: true,
            taskType,
            assigneeId: null,
            labels: ['hypothesis'],
        };
    }

    if (!hasFullTaskCreate) {
        return {
            allowed: false,
            taskType,
            assigneeId: null,
            denyMessage: `Error: Role "${args.role || 'unknown'}" cannot create team tasks. Use a coordinator/bootstrap role such as master, orchestrator, or org-manager. Non-coordinator roles may only capture unassigned hypothesis tasks via type="hypothesis".`,
        };
    }

    return {
        allowed: true,
        taskType,
        assigneeId: args.requestedAssigneeId || null,
    };
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(Math.max(Math.trunc(value as number), 0), max);
}

/**
 * Resolve the authoritative session id to be used in task-route mutations.
 *
 * In codex/runtime-adapter/session-recovery scenarios, `client.sessionId`
 * may be a local tracking id instead of the AHA session id known by server.
 * Task routes validate actor/reporter session ids against roster/account and
 * return 400 when mismatched. Prefer metadata.ahaSessionId when present.
 */
export function resolveTaskActorSessionId(
    metadata: { ahaSessionId?: string } | null | undefined,
    clientSessionId: string,
): string {
    const authoritativeSessionId = typeof metadata?.ahaSessionId === 'string'
        ? metadata.ahaSessionId.trim()
        : '';
    return authoritativeSessionId.length > 0 ? authoritativeSessionId : clientSessionId;
}

export function summarizeTaskForList(task: ListableTask): Record<string, unknown> {
    return {
        id: task.id,
        title: typeof task.title === 'string' ? task.title : task.id,
        status: typeof task.status === 'string' ? task.status : 'todo',
        priority: typeof task.priority === 'string' ? task.priority : null,
        assigneeId: typeof task.assigneeId === 'string' ? task.assigneeId : null,
        reporterId: typeof task.reporterId === 'string' ? task.reporterId : null,
        parentTaskId: typeof task.parentTaskId === 'string' ? task.parentTaskId : null,
        approvalStatus: typeof task.approvalStatus === 'string' ? task.approvalStatus : null,
        labels: Array.isArray(task.labels)
            ? task.labels.filter((value): value is string => typeof value === 'string')
            : [],
        depth: typeof task.depth === 'number' ? task.depth : 0,
        updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : null,
        createdAt: typeof task.createdAt === 'number' ? task.createdAt : null,
        commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
        blockerCount: Array.isArray(task.blockers) ? task.blockers.length : 0,
        acceptanceCriteriaCount: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.length : 0,
        subtaskCount: Array.isArray(task.subtaskIds) ? task.subtaskIds.length : 0,
    };
}

export function buildShowAllTaskPage(args: ShowAllTaskPageArgs): Record<string, unknown> {
    const filteredTasks = args.status
        ? args.tasks.filter((task) => task.status === args.status)
        : args.tasks;
    const cursor = clampPositiveInteger(args.cursor, 0, Math.max(filteredTasks.length, 0));
    const limit = Math.max(1, clampPositiveInteger(args.limit, 25, 100) || 25);
    const pageTasks = filteredTasks.slice(cursor, cursor + limit);
    const nextCursor = cursor + pageTasks.length < filteredTasks.length
        ? cursor + pageTasks.length
        : null;

    const statusCounts = {
        todo: 0,
        'in-progress': 0,
        review: 0,
        blocked: 0,
        done: 0,
    };

    for (const task of filteredTasks) {
        const status = task.status;
        if (status === 'todo' || status === 'in-progress' || status === 'review' || status === 'blocked' || status === 'done') {
            statusCounts[status] += 1;
        }
    }

    const pendingApprovals = Array.isArray(args.pendingApprovals)
        ? args.pendingApprovals.map((task) => summarizeTaskForList(task as ListableTask))
        : [];

    return {
        mode: 'board-overview',
        filters: {
            ...(args.status ? { status: args.status } : {}),
        },
        teamStats: args.teamStats ?? null,
        pendingApprovals,
        boardOverview: {
            totalBoardTasks: args.tasks.length,
            matchingTasks: filteredTasks.length,
            returnedTasks: pageTasks.length,
            statusCounts,
            pendingApprovalCount: pendingApprovals.length,
        },
        allTasks: pageTasks.map((task) => summarizeTaskForList(task)),
        pagination: {
            cursor,
            limit,
            nextCursor,
            hasMore: nextCursor !== null,
        },
        guidance: {
            next: nextCursor !== null
                ? `Call list_tasks({ showAll: true, cursor: ${nextCursor}, limit: ${limit}${args.status ? `, status: "${args.status}"` : ''} }) for the next page.`
                : 'No more tasks in this filtered view.',
            details: 'Call get_task({ taskId }) for the full task description and complete comment history.',
        },
    };
}

export function registerTaskTools(ctx: McpToolContext): void {
    const {
        mcp,
        api,
        client,
        genomeSpecRef,
        getTaskStateManager,
        getCurrentTeamMemberContext,
    } = ctx;

    // Create Task - Uses REST API for server-driven task orchestration with WebSocket events
    mcp.registerTool('create_task', {
        description: 'Create a new task for the team. Bootstrap/coordinator roles can create regular team tasks; any role may capture an unassigned hypothesis via type="hypothesis".',
        title: 'Create Task',
        inputSchema: {
            title: z.string().describe('Task title'),
            description: z.string().optional().describe('Detailed task description'),
            type: z.enum(['standard', 'hypothesis']).optional().describe('Task type. Non-coordinator roles may only create type="hypothesis", which is always unassigned and labeled hypothesis.'),
            assigneeId: z.string().optional().describe('Session ID of the assignee'),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Task priority (default: medium)'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const sessionId = resolveTaskActorSessionId(metadata, client.sessionId);

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to create tasks.' }], isError: true };
            }

            const { effectiveGenome } = await getCurrentTeamMemberContext(teamId);
            const creationPolicy = resolveCreateTaskPolicy({
                role,
                effectiveGenome,
                requestedType: args.type,
                requestedAssigneeId: args.assigneeId,
            });
            if (!creationPolicy.allowed) {
                return {
                        content: [{
                            type: 'text',
                        text: creationPolicy.denyMessage || 'Error: Task creation denied.'
                    }],
                    isError: true
                };
            }

            // Use REST API - server handles artifact update + WebSocket event emission
            const taskData = {
                title: args.title,
                description: args.description || '',
                status: 'todo' as const,
                assigneeId: creationPolicy.assigneeId,
                reporterId: sessionId,
                priority: args.priority || 'medium',
                labels: creationPolicy.labels,
            };

            const result = await api.createTask(teamId, taskData);

            if (!result.success || !result.task) {
                return { content: [{ type: 'text', text: `Error: Failed to create task via server API. Verify: title is non-empty, priority is one of [low, medium, high, urgent], assigneeId (if provided) is a valid session ID. Team: ${teamId}, role: ${role}.` }], isError: true };
            }

            // ── Trace: task_created ─────────────────────────────────────
            try {
                emitTraceEvent(
                    TraceEventKind.task_created,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: result.task.id,
                        session_id: sessionId,
                    },
                    `Task "${result.task.title}" created (priority=${result.task.priority}, assignee=${args.assigneeId || 'none'})`,
                    { attrs: { title: result.task.title, assigneeId: args.assigneeId } },
                );
            } catch { /* trace must never break main flow */ }

            // Notify Team
            try {
                const notification = {
                    id: randomUUID(),
                    teamId,
                    content: `🆕 **New Task Created**: ${result.task.title}\nAssignee: ${args.assigneeId || 'None'}\nPriority: ${result.task.priority}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: sessionId,
                    fromRole: role,
                    mentions: args.assigneeId ? [args.assigneeId] : []
                };
                await api.sendTeamMessage(teamId, notification);
            } catch (e) {
                logger.debug('Failed to send task notification', e);
            }

            return {
                content: [{ type: 'text', text: `Task created successfully. ID: ${result.task.id}` }],
                isError: false,
            };

        } catch (error) {
            return { content: [{ type: 'text', text: `Error creating task: ${String(error)}` }], isError: true };
        }
    });

    // Update Task - Uses REST API for server-driven task orchestration with WebSocket events
    mcp.registerTool('update_task', {
        description: 'Update an existing task\'s status, assignee, or details. If you are changing review state, handing work off, or making a decision another agent must inherit, include a comment so the task carries memory with it.',
        title: 'Update Task',
        inputSchema: {
            taskId: z.string().describe('The ID of the task to update'),
            status: z.enum(['todo', 'in-progress', 'review', 'done']).optional().describe('New status'),
            assigneeId: z.string().optional().describe('New assignee Session ID'),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('New priority'),
            comment: z.string().optional().describe('Add a comment/note to the task'),
            commentType: z.enum(['note', 'status-change', 'review-feedback', 'handoff', 'decision', 'plan', 'plan-review', 'execution-check', 'rework-request']).optional().describe('Optional structured comment type'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const sessionId = resolveTaskActorSessionId(metadata, client.sessionId);

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to update tasks.' }], isError: true };
            }

            const { authorities } = await getCurrentTeamMemberContext(teamId);
            const hasTeamWideTaskWrite =
                hasTeamAuthority(authorities, 'task.update.any')
                || hasTeamAuthority(authorities, 'task.assign')
                || hasTeamAuthority(authorities, 'task.create')
                || hasTeamAuthority(authorities, 'task.approve');
            const isRestrictedWorker = !hasTeamWideTaskWrite;
            const isReviewer = role === 'reviewer' && !hasTeamWideTaskWrite;

            if (isReviewer) {
                return { content: [{ type: 'text', text: 'Error: REVIEWER role is read-only and cannot update tasks. Use add_task_comment with type="review-feedback" to leave review notes instead.' }], isError: true };
            }

            if (args.status === 'in-progress') {
                return {
                    content: [{
                        type: 'text',
                        text: 'Error: Use start_task to acknowledge and begin a task. update_task cannot move a task into in-progress.'
                    }],
                    isError: true
                };
            }

            // First fetch the task to check permissions for workers
            if (isRestrictedWorker) {
                try {
                    const existingTask = await api.getTask(teamId, args.taskId);
                    if (existingTask) {
                        const assignedToSelf = existingTask.assigneeId === sessionId;
                        const claimingSelf = !existingTask.assigneeId && args.assigneeId === sessionId;

                        if (!assignedToSelf && !claimingSelf) {
                            return {
                                content: [{ type: 'text', text: `Error: Workers can only update tasks assigned to them. This task is assigned to ${existingTask.assigneeId ?? '(unassigned)'}, your session is ${sessionId} (role: ${role}). Options: (1) ask a coordinator to reassign, (2) use add_task_comment to leave notes, (3) use send_team_message to request the change.` }],
                                isError: true
                            };
                        }

                        if (args.assigneeId && args.assigneeId !== sessionId) {
                            return {
                                content: [{ type: 'text', text: `Error: Workers cannot reassign tasks to other members. Your session: ${sessionId}. Use send_team_message to request a coordinator to reassign task ${args.taskId}.` }],
                                isError: true
                            };
                        }
                    }
                } catch (e) {
                    // Task not found will be handled by updateTask call
                }
            }

            // Build updates object
            const updates: any = {
                actor: {
                    sessionId,
                    role,
                    displayName: metadata?.displayName || metadata?.name,
                    kind: role === 'user' ? 'human' : 'agent',
                },
            };
            if (args.status) updates.status = args.status;
            if (args.assigneeId) updates.assigneeId = args.assigneeId;
            if (args.priority) updates.priority = args.priority;
            if (args.comment) {
                updates.comment = {
                    sessionId,
                    role,
                    displayName: metadata?.displayName || metadata?.name,
                    type: args.commentType || (
                        args.assigneeId ? 'handoff'
                            : args.status === 'review' ? 'review-feedback'
                                : args.status ? 'status-change'
                                    : 'note'
                    ),
                    content: args.comment,
                    fromStatus: undefined,
                    toStatus: args.status,
                    mentions: args.assigneeId ? [args.assigneeId] : undefined,
                };
            }

            // Use REST API - server handles artifact update + WebSocket event emission
            const result = await api.updateTask(teamId, args.taskId, updates);

            if (!result.success || !result.task) {
                return { content: [{ type: 'text', text: `Error: Failed to update task ${args.taskId} via server API. Valid status: [todo, in-progress, review, done, blocked]. Valid priority: [low, medium, high, urgent]. Team: ${teamId}, role: ${role}.` }], isError: true };
            }

            // Notify Team
            try {
                let updateMsg = `🔄 **Task Updated**: ${result.task.title}`;
                if (args.status) {
                    updateMsg += `\nStatus: → ${args.status}`;
                }
                if (args.assigneeId) {
                    updateMsg += `\nAssignee: ${args.assigneeId}`;
                }
                if (args.priority) {
                    updateMsg += `\nPriority: ${args.priority}`;
                }
                if (args.comment) {
                    updateMsg += `\nComment: ${args.comment}`;
                }

                const notification = {
                    id: randomUUID(),
                    teamId,
                    content: updateMsg,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: sessionId,
                    fromRole: role,
                    mentions: args.assigneeId ? [args.assigneeId] : []
                };
                await api.sendTeamMessage(teamId, notification);
            } catch (e) {
                logger.debug('Failed to send task notification', e);
            }

            return {
                content: [{ type: 'text', text: `Task ${args.taskId} updated successfully.` }],
                isError: false,
            };

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const normalized = message.replace(/^Error:\s*/, '');
            if (normalized.includes('TASK_LOCKED_BY_HUMAN')) {
                return { content: [{ type: 'text', text: normalized.replace(/^Failed to update task:\s*/, '') }], isError: true };
            }
            return { content: [{ type: 'text', text: `Error updating task: ${normalized}` }], isError: true };
        }
    });

    mcp.registerTool('add_task_comment', {
        description: 'Add persistent review/handoff memory to a task. Use this when feedback or rationale should stay attached to the task itself, not only in chat. Preferred for review notes, handoff rationale, blocker context, and decisions that the next agent must inherit.',
        title: 'Add Task Comment',
        inputSchema: {
            taskId: z.string().describe('The ID of the task to comment on'),
            content: z.string().describe('Comment text'),
            type: z.enum(['note', 'status-change', 'review-feedback', 'handoff', 'blocker', 'decision', 'plan', 'plan-review', 'execution-check', 'rework-request']).default('note').describe('Structured comment type'),
            mentions: z.array(z.string()).optional().describe('Optional session IDs to mention'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const sessionId = resolveTaskActorSessionId(metadata, client.sessionId);

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to add task comments.' }], isError: true };
            }

            const result = await api.addTaskComment(teamId, args.taskId, {
                sessionId,
                role,
                displayName: metadata?.displayName || metadata?.name,
                type: args.type,
                content: args.content,
                mentions: args.mentions,
            });

            if (!result.success || !result.task) {
                return { content: [{ type: 'text', text: 'Error: Failed to add task comment.' }], isError: true };
            }

            return {
                content: [{ type: 'text', text: `Comment added to task ${args.taskId}.` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error adding task comment: ${String(error)}` }], isError: true };
        }
    });

    // Delete Task - Uses REST API for server-driven task orchestration with WebSocket events
    mcp.registerTool('delete_task', {
        description: 'Delete a task from the team board. Coordinator roles can delete tasks.',
        title: 'Delete Task',
        inputSchema: {
            taskId: z.string().describe('The ID of the task to delete'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to delete tasks.' }], isError: true };
            }

            const { effectiveGenome } = await getCurrentTeamMemberContext(teamId);
            if (!canManageExistingTasks(role, effectiveGenome)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot delete tasks. Ask a coordinator role to handle this.`
                    }],
                    isError: true
                };
            }

            // Use REST API - server handles artifact update + WebSocket event emission
            const result = await api.deleteTask(teamId, args.taskId);

            if (!result.success) {
                return { content: [{ type: 'text', text: 'Error: Failed to delete task via server API.' }], isError: true };
            }

            // Notify Team
            try {
                const notification = {
                    id: randomUUID(),
                    teamId,
                    content: `🗑️ **Task Deleted**: ${args.taskId}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: resolveTaskActorSessionId(metadata, client.sessionId),
                    fromRole: role,
                };
                await api.sendTeamMessage(teamId, notification);
            } catch (e) {
                logger.debug('Failed to send task deletion notification', e);
            }

            return {
                content: [{ type: 'text', text: `Task ${args.taskId} deleted successfully.` }],
                isError: false,
            };

        } catch (error) {
            return { content: [{ type: 'text', text: `Error deleting task: ${String(error)}` }], isError: true };
        }
    });

    // List Tasks - Uses TaskStateManager for role-based filtering
    mcp.registerTool('list_tasks', {
        description: 'List tasks for the current team. Default mode returns role-filtered context. When showAll=true, returns a paginated board overview with task summaries so large boards do not overflow context.',
        title: 'List Tasks',
        inputSchema: {
            status: z.enum(['todo', 'in-progress', 'review', 'done', 'blocked']).optional().describe('Filter by status'),
            showAll: z.boolean().optional().describe('If true, returns a paginated board-wide overview instead of role-filtered context.'),
            cursor: z.number().int().min(0).optional().describe('When showAll=true, zero-based cursor for the next task page. Default 0.'),
            limit: z.number().int().min(1).max(100).optional().describe('When showAll=true, max number of task summaries to return. Default 25.'),
        },
    }, async (args) => {
        try {
            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to list tasks.' }], isError: true };
            }

            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const { effectiveGenome } = teamId
                ? await getCurrentTeamMemberContext(teamId)
                : { effectiveGenome: genomeSpecRef?.current ?? null };
            const isCoordinator = canManageExistingTasks(role, effectiveGenome);

            // Get role-filtered context via TaskStateManager
            const kanbanContext = await taskManager.getFilteredContext();

            // Format output based on role and args
            let output: any;
            if (args.showAll) {
                const board = await taskManager.getBoard();
                output = buildShowAllTaskPage({
                    tasks: (board.tasks || []) as ListableTask[],
                    status: args.status,
                    cursor: args.cursor,
                    limit: args.limit,
                    teamStats: kanbanContext.teamStats,
                    pendingApprovals: kanbanContext.pendingApprovals,
                });
            } else {
                // Role-filtered context
                let myTasks = kanbanContext.myTasks;
                let availableTasks = kanbanContext.availableTasks;
                if (args.status) {
                    myTasks = myTasks.filter((t: any) => t.status === args.status);
                    availableTasks = availableTasks.filter((t: any) => t.status === args.status);
                }
                output = {
                    myTasks,
                    availableTasks,
                    teamStats: kanbanContext.teamStats,
                    ...(kanbanContext.pendingApprovals ? { pendingApprovals: kanbanContext.pendingApprovals } : {})
                };
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error listing tasks: ${String(error)}` }], isError: true };
        }
    });

    // Get Task - Returns full task with all comments (no truncation)
    mcp.registerTool('get_task', {
        description: 'Get full details of a single task including ALL comments (no truncation). Use this after list_tasks to read the complete comment history before starting work on a task.',
        title: 'Get Task',
        inputSchema: {
            taskId: z.string().describe('Task ID to fetch'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to get task details.' }], isError: true };
            }
            const task = await api.getTask(teamId, args.taskId);
            if (!task) {
                return { content: [{ type: 'text', text: `Error: Task ${args.taskId} not found.` }], isError: true };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error getting task: ${String(error)}` }], isError: true };
        }
    });

    // ========== 嵌套任务工具 (v2) ==========

    // Create Subtask - Uses REST API for server-driven task orchestration with WebSocket events
    mcp.registerTool('create_subtask', {
        description: 'Create a subtask under an existing task. Use this to break down complex tasks into smaller, manageable pieces. Coordinator roles can create subtasks.',
        title: 'Create Subtask',
        inputSchema: {
            parentTaskId: z.string().describe('ID of the parent task'),
            title: z.string().describe('Subtask title'),
            description: z.string().optional().describe('Detailed subtask description'),
            assigneeId: z.string().optional().describe('Session ID of the assignee (inherits from parent if not specified)'),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Subtask priority (inherits from parent if not specified)'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const sessionId = resolveTaskActorSessionId(metadata, client.sessionId);

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to create subtasks.' }], isError: true };
            }

            const { effectiveGenome } = await getCurrentTeamMemberContext(teamId);
            if (!canManageExistingTasks(role, effectiveGenome)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot create subtasks. Ask a coordinator role to handle this.`
                    }],
                    isError: true
                };
            }

            // Get parent task to inherit properties
            let parentTask: any = null;
            try {
                parentTask = await api.getTask(teamId, args.parentTaskId);
            } catch (e) {
                return { content: [{ type: 'text', text: `Error: Parent task ${args.parentTaskId} not found.` }], isError: true };
            }

            if (!parentTask) {
                return { content: [{ type: 'text', text: `Error: Parent task ${args.parentTaskId} not found.` }], isError: true };
            }

            // Use REST API - server handles artifact update + WebSocket event emission
            const subtaskData = {
                title: args.title,
                description: args.description || '',
                status: 'todo' as const,
                assigneeId: args.assigneeId ?? parentTask.assigneeId ?? null,
                reporterId: sessionId,
                priority: args.priority ?? parentTask.priority ?? 'medium',
                parentTaskId: args.parentTaskId,
            };

            const result = await api.createTask(teamId, subtaskData);

            if (!result.success || !result.task) {
                return { content: [{ type: 'text', text: 'Error: Failed to create subtask via server API.' }], isError: true };
            }

            // Notify team
            try {
                await api.sendTeamMessage(teamId, {
                    id: randomUUID(),
                    teamId,
                    content: `📌 Subtask created under "${parentTask.title}":\n• ${result.task.title}\nAssignee: ${result.task.assigneeId || 'Unassigned'}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: sessionId,
                    fromRole: role,
                    mentions: result.task.assigneeId ? [result.task.assigneeId] : []
                });
            } catch (e) { logger.debug('Failed to send subtask notification', e); }

            return {
                content: [{ type: 'text', text: `Subtask created successfully.\nID: ${result.task.id}\nParent: ${parentTask.title}` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error creating subtask: ${String(error)}` }], isError: true };
        }
    });

    // List Subtasks - 列出子任务
    mcp.registerTool('list_subtasks', {
        description: 'List all subtasks of a given task.',
        title: 'List Subtasks',
        inputSchema: {
            parentTaskId: z.string().describe('ID of the parent task'),
            includeNested: z.boolean().optional().describe('Include deeply nested subtasks (default: false)'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                // Artifact doesn't exist - try to create it (lazy initialization)
                logger.debug(`[MCP] Team artifact ${teamId} not found, attempting lazy initialization...`);
                try {
                    const initialHeader = {
                        type: 'team',
                        name: `Team ${teamId.substring(0, 8)}`,
                        createdAt: Date.now()
                    };
                    const initialBody = {
                        tasks: [],
                        columns: [
                            { id: 'todo', title: 'To Do', order: 0 },
                            { id: 'in-progress', title: 'In Progress', order: 1 },
                            { id: 'review', title: 'Review', order: 2 },
                            { id: 'done', title: 'Done', order: 3 }
                        ],
                        members: [],
                        createdAt: Date.now()
                    };
                    artifact = await api.createArtifact(teamId, initialHeader, initialBody);
                    logger.debug(`[MCP] Successfully created team artifact ${teamId}`);

                    // Verify artifact body is correctly initialized
                    try {
                        logger.debug(`[MCP] Verifying team artifact ${teamId} body initialization...`);
                        const verificationArtifact = await api.getArtifact(teamId);

                        if (!verificationArtifact.body) {
                            throw new Error(
                                `Team artifact created but body not initialized. ` +
                                `This may indicate a server-side initialization issue. ` +
                                `Please try again or contact support.`
                            );
                        }

                        // Try to parse the body to ensure it's valid
                        let bodyValid = false;
                        if (typeof verificationArtifact.body === 'string') {
                            try {
                                JSON.parse(verificationArtifact.body);
                                bodyValid = true;
                            } catch {
                                // Body is a string but not valid JSON
                            }
                        } else if (typeof verificationArtifact.body === 'object') {
                            bodyValid = true;
                        }

                        if (!bodyValid) {
                            throw new Error(
                                `Team artifact body is malformed. ` +
                                `Expected valid JSON structure but got: ${typeof verificationArtifact.body}`
                            );
                        }

                        logger.debug(`[MCP] Team artifact ${teamId} body verified successfully`);
                        artifact = verificationArtifact; // Use the verified artifact

                    } catch (verifyError) {
                        logger.debug(`[MCP] Team artifact ${teamId} verification failed:`, verifyError);
                        // Clean up the potentially broken artifact
                        try {
                            // Note: We don't have a delete artifact API yet, so we just log
                            logger.debug(`[MCP] Team artifact ${teamId} may need manual cleanup`);
                        } catch {
                            // Ignore cleanup errors
                        }
                        throw new Error(
                            `Team artifact verification failed: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`
                        );
                    }

                } catch (createError) {
                    logger.debug(`[MCP] Failed to create team artifact ${teamId}:`, createError);
                    return { content: [{ type: 'text', text: `Error: ${createError instanceof Error ? createError.message : 'Failed to fetch or create team artifact.'}` }], isError: true };
                }
            }

            let board: any = { tasks: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                const bodyValue = (artifact.body as { body?: unknown }).body;
                if (typeof bodyValue === 'string') {
                    try { board = JSON.parse(bodyValue); } catch (e) { /* ignore */ }
                } else if (bodyValue && typeof bodyValue === 'object') {
                    board = bodyValue;
                }
            } else if (artifact.body) {
                board = artifact.body;
            }

            const parentTask = board.tasks?.find((t: any) => t.id === args.parentTaskId);
            if (!parentTask) {
                return { content: [{ type: 'text', text: `Task ${args.parentTaskId} not found.` }], isError: true };
            }

            let subtasks: any[] = [];
            if (args.includeNested) {
                // Recursively collect all subtasks
                const collectSubtasks = (taskId: string) => {
                    const task = board.tasks.find((t: any) => t.id === taskId);
                    if (!task) return;
                    task.subtaskIds?.forEach((stid: string) => {
                        const st = board.tasks.find((t: any) => t.id === stid);
                        if (st) {
                            subtasks.push(st);
                            collectSubtasks(stid);
                        }
                    });
                };
                collectSubtasks(args.parentTaskId);
            } else {
                // Direct children only
                subtasks = board.tasks.filter((t: any) => parentTask.subtaskIds?.includes(t.id));
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(subtasks, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error listing subtasks: ${String(error)}` }], isError: true };
        }
    });

    // Start Task - Uses TaskStateManager for execution link management and state broadcasting
    mcp.registerTool('start_task', {
        description: 'Mark a task as actively being worked on by you. Creates an execution link between your session and the task. After start_task, you should read the full task with get_task and leave a type=plan task comment before implementation.',
        title: 'Start Task',
        inputSchema: {
            taskId: z.string().describe('ID of the task to start'),
            comment: z.string().optional().describe('Optional note explaining what you are starting or how you will approach it'),
        },
    }, async (args) => {
        try {
            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            // Delegate to TaskStateManager which handles:
            // - Execution link creation
            // - Status change to 'in-progress'
            // - State change broadcasting
            // - Team message notification
            const result = await taskManager.startTaskWithComment(args.taskId, args.comment ? {
                displayName: client.getMetadata()?.displayName || client.getMetadata()?.name,
                content: args.comment,
            } : undefined);

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            // Get task details for response
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            // ── Trace: task_started ─────────────────────────────────────
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            try {
                emitTraceEvent(
                    TraceEventKind.task_started,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: args.taskId,
                        session_id: client.sessionId,
                    },
                    `Task "${taskTitle}" started by ${metadata?.role || 'unknown'}`,
                );
            } catch { /* trace must never break main flow */ }

            // ── Pending handoff context ──────────────────────────────────
            // Surface the most recent handoff comment so the successor agent
            // can immediately read context without a separate get_task call.
            let pendingHandoff: { content: string; authorRole?: string; authorDisplayName?: string; createdAt?: number } | null = null;
            if (teamId) {
                try {
                    const fullTask = await api.getTask(teamId, args.taskId);
                    const comments: Array<any> = fullTask?.comments ?? [];
                    const handoffComment = comments
                        .filter((c: any) => c.type === 'handoff')
                        .sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
                    if (handoffComment) {
                        pendingHandoff = {
                            content: handoffComment.content,
                            authorRole: handoffComment.authorRole,
                            authorDisplayName: handoffComment.authorDisplayName,
                            createdAt: handoffComment.createdAt,
                        };
                    }
                } catch { /* handoff fetch must never break start_task */ }
            }

            const responseText = pendingHandoff
                ? `Started working on: "${taskTitle}"\nStatus: in-progress\n\n📋 Pending handoff:\n${pendingHandoff.content}`
                : `Started working on: "${taskTitle}"\nStatus: in-progress`;

            return {
                content: [{ type: 'text', text: responseText }],
                isError: false,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const normalized = message.replace(/^Error:\s*/, '');
            if (normalized.includes('TASK_LOCKED_BY_HUMAN')) {
                const hint = '\nOptions: (1) add_task_comment to leave notes while locked, (2) wait for human to release, (3) pick a different available task.';
                return { content: [{ type: 'text', text: normalized.replace(/^Failed to start task:\s*/, '') + hint }], isError: true };
            }
            return { content: [{ type: 'text', text: `Error starting task: ${normalized}` }], isError: true };
        }
    });

    // Complete Task - Uses TaskStateManager for status propagation and state broadcasting
    mcp.registerTool('complete_task', {
        description: 'Mark a task as complete. If all subtasks of a parent are done, the parent will automatically move to review. Add a completion comment when reviewers need context about what changed or what to verify.',
        title: 'Complete Task',
        inputSchema: {
            taskId: z.string().describe('ID of the task to complete'),
            comment: z.string().optional().describe('Optional completion note summarizing what changed or what reviewers should check'),
        },
    }, async (args) => {
        try {
            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            // Get task details for response message
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            // Delegate to TaskStateManager which handles:
            // - Incomplete subtask validation
            // - Execution link status update
            // - Status propagation to parent tasks
            // - State change broadcasting
            // - Team message notification
            const result = await taskManager.completeTaskWithComment(args.taskId, args.comment ? {
                role: client.getMetadata()?.role,
                displayName: client.getMetadata()?.displayName || client.getMetadata()?.name,
                content: args.comment,
            } : undefined);

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            const propagatedCount = result.propagatedTasks?.length ? result.propagatedTasks.length - 1 : 0;

            // ── Trace: task_completed ────────────────────────────────────
            try {
                const metadata = client.getMetadata();
                const teamId = metadata?.teamId || metadata?.roomId;
                emitTraceEvent(
                    TraceEventKind.task_completed,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: args.taskId,
                        session_id: client.sessionId,
                    },
                    `Task "${taskTitle}" completed by ${metadata?.role || 'unknown'} (propagated to ${propagatedCount} parent(s))`,
                );
            } catch { /* trace must never break main flow */ }

            // After completing, fetch remaining tasks to prompt agent to claim next work
            const updatedBoard = await taskManager.getBoard();
            const mySessionId = client.sessionId;
            const metadata = client.getMetadata();
            const remainingTodo = (updatedBoard.tasks || []).filter((t: any) =>
                t.status === 'todo' && !t.assigneeSessionId
            );
            const myTasks = (updatedBoard.tasks || []).filter((t: any) =>
                t.status === 'todo' && t.assigneeSessionId === mySessionId
            );

            const nextTaskHint = myTasks.length > 0
                ? `\n\n📋 You have ${myTasks.length} assigned task(s) waiting. Use list_tasks() to see them and start_task() on the next one.`
                : remainingTodo.length > 0
                    ? `\n\n📋 ${remainingTodo.length} unassigned task(s) available on the board. Use list_tasks() to review and start_task() to claim one.`
                    : '\n\n✅ No more pending tasks on the board.';

            return {
                content: [{ type: 'text', text: `Task "${taskTitle}" completed.\nPropagated to ${propagatedCount} parent task(s).${nextTaskHint}` }],
                isError: false,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const normalized = message.replace(/^Error:\s*/, '');
            if (normalized.includes('TASK_LOCKED_BY_HUMAN')) {
                return { content: [{ type: 'text', text: normalized.replace(/^Failed to complete task:\s*/, '') }], isError: true };
            }
            return { content: [{ type: 'text', text: `Error completing task: ${normalized}` }], isError: true };
        }
    });

    // Report Blocker - Uses TaskStateManager for blocker tracking and state broadcasting
    mcp.registerTool('report_blocker', {
        description: 'Report a blocker on a task. This will mark the task as blocked and notify the Master. Include enough context that another agent can inherit the task without re-discovering the blocker.',
        title: 'Report Blocker',
        inputSchema: {
            taskId: z.string().describe('ID of the blocked task'),
            type: z.enum(['dependency', 'question', 'resource', 'technical']).describe('Type of blocker'),
            description: z.string().describe('Detailed description of the blocker'),
            comment: z.string().optional().describe('Optional extra context, mitigation attempts, or handoff note'),
        },
    }, async (args) => {
        try {
            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            // Get task details for response message
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            // Delegate to TaskStateManager which handles:
            // - Blocker creation with UUID
            // - Status change to 'blocked'
            // - hasBlockedChild propagation to parents
            // - State change broadcasting
            // - Team message notification (help-needed type)
            const result = await taskManager.reportBlocker(
                args.taskId,
                args.type,
                args.description,
                {
                    role: client.getMetadata()?.role,
                    displayName: client.getMetadata()?.displayName || client.getMetadata()?.name,
                    mentions: undefined,
                    content: args.comment,
                }
            );

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            // ── Trace: task_blocked ──────────────────────────────────────
            try {
                const metadata = client.getMetadata();
                const teamId = metadata?.teamId || metadata?.roomId;
                emitTraceEvent(
                    TraceEventKind.task_blocked,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: args.taskId,
                        session_id: client.sessionId,
                    },
                    `Task "${taskTitle}" blocked (${args.type}): ${args.description.slice(0, 200)}`,
                    { status: 'blocked', attrs: { blockerType: args.type, blockerId: result.blockerId } },
                );
            } catch { /* trace must never break main flow */ }

            return {
                content: [{ type: 'text', text: `Blocker reported on "${taskTitle}".\nBlocker ID: ${result.blockerId}\nMaster has been notified.` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error reporting blocker: ${String(error)}` }], isError: true };
        }
    });

    // Resolve Blocker - Uses TaskStateManager for blocker resolution and state broadcasting
    mcp.registerTool('resolve_blocker', {
        description: 'Resolve a blocker on a task. Coordinator roles can resolve blockers. Add a follow-up note when the assignee or reviewer needs to understand what changed.',
        title: 'Resolve Blocker',
        inputSchema: {
            taskId: z.string().describe('ID of the task with the blocker'),
            blockerId: z.string().describe('ID of the blocker to resolve'),
            resolution: z.string().describe('How the blocker was resolved'),
            comment: z.string().optional().describe('Optional follow-up note for the assignee or reviewer'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const role = metadata?.role;

            const teamId = metadata?.teamId || metadata?.roomId;
            const { effectiveGenome } = teamId
                ? await getCurrentTeamMemberContext(teamId)
                : { effectiveGenome: genomeSpecRef?.current ?? null };
            if (!canManageExistingTasks(role, effectiveGenome)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot resolve blockers. Ask a coordinator role to handle this.`
                    }],
                    isError: true
                };
            }

            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            // Get task details for response message
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            // Delegate to TaskStateManager which handles:
            // - Blocker resolution timestamp
            // - Status change back to 'in-progress' if no more blockers
            // - Parent hasBlockedChild flag update
            // - State change broadcasting
            // - Team message notification
            const result = await taskManager.resolveBlocker(
                args.taskId,
                args.blockerId,
                args.resolution,
                args.comment ? {
                    role,
                    displayName: metadata?.displayName || metadata?.name,
                    type: 'decision',
                    content: args.comment,
                } : undefined
            );

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            // Get updated task status
            const updatedBoard = await taskManager.getBoard();
            const updatedTask = updatedBoard.tasks?.find((t: any) => t.id === args.taskId);
            const newStatus = updatedTask?.status || 'in-progress';

            return {
                content: [{ type: 'text', text: `Blocker resolved on "${taskTitle}".\nTask status: ${newStatus}` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error resolving blocker: ${String(error)}` }], isError: true };
        }
    });

    // ========== Release Task Locks ==========

    mcp.registerTool('release_task_locks', {
        description: 'Release all active task execution locks for a dead or stuck session. Coordinator roles can release locks so other agents can claim the tasks. Use this when start_task fails because a dead session still holds the lock.',
        title: 'Release Task Locks',
        inputSchema: {
            sessionId: z.string().describe('Session ID whose task locks should be released'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const role = metadata?.role;
            const teamId = metadata?.teamId || metadata?.roomId;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: No team context found.' }], isError: true };
            }

            const { effectiveGenome } = await getCurrentTeamMemberContext(teamId);
            if (!canManageExistingTasks(role, effectiveGenome)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot release task locks. Only coordinator roles can do this.`,
                    }],
                    isError: true,
                };
            }

            const result = await api.releaseSessionTaskLocks(teamId, args.sessionId);
            const count = result.unlockedTaskIds?.length ?? 0;
            return {
                content: [{
                    type: 'text',
                    text: count > 0
                        ? `Released ${count} task lock(s) for session ${args.sessionId}. Unlocked tasks: ${result.unlockedTaskIds.join(', ')}`
                        : `No active task locks found for session ${args.sessionId}.`,
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error releasing task locks: ${String(error)}` }], isError: true };
        }
    });

    // ========== End 嵌套任务工具 ==========
}
