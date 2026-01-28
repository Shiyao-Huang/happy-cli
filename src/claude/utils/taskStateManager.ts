/**
 * Task State Manager
 *
 * Server-Driven Task Orchestration Client
 *
 * This is a thin client that delegates all task mutations to the server.
 * The server is the SINGLE SOURCE OF TRUTH for task state.
 *
 * Key Features:
 * - All mutations go through server API
 * - Local cache updated via WebSocket events
 * - Handles task events from server in real-time
 * - Backward compatible with existing code
 */

import { randomUUID } from 'crypto';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { filterTasksForRole } from '@/claude/team/taskFilter';
import { KanbanContext } from '@/claude/team/roles';

// === State Change Broadcasting Types ===

export type KanbanStateChangeType =
    | 'task-created'
    | 'task-updated'
    | 'task-deleted'
    | 'task-status-changed'
    | 'task-assigned'
    | 'subtask-created'
    | 'blocker-reported'
    | 'blocker-resolved'
    | 'execution-started'
    | 'execution-completed';

export interface KanbanStateChange {
    type: KanbanStateChangeType;
    taskId: string;
    taskTitle: string;
    details: Record<string, any>;
    triggeredBy: string;
    timestamp: number;
}

export type StateChangeCallback = (change: KanbanStateChange) => void;

// 类型定义 (与 kanban/sources/sync/kanbanTypes.ts 保持同步)
interface TaskExecutionLink {
    sessionId: string;
    linkedAt: number;
    role: 'primary' | 'supporting';
    status: 'active' | 'completed' | 'abandoned';
}

interface TaskBlocker {
    id: string;
    type: 'dependency' | 'question' | 'resource' | 'technical';
    description: string;
    raisedAt: number;
    raisedBy?: string;
    resolvedAt?: number;
    resolvedBy?: string;
    resolution?: string;
}

interface StatusPropagation {
    autoCompleteParent: boolean;
    blockParentOnBlocked: boolean;
    cascadeDeleteSubtasks: boolean;
}

interface KanbanTask {
    id: string;
    title: string;
    description?: string;
    status: string;
    assigneeId?: string | null;
    reporterId?: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    createdAt: number;
    updatedAt: number;
    parentTaskId?: string | null;
    subtaskIds?: string[];
    depth?: number;
    statusPropagation?: StatusPropagation;
    hasBlockedChild?: boolean;
    executionLinks?: TaskExecutionLink[];
    blockers?: TaskBlocker[];
}

interface KanbanBoard {
    columns: { id: string; title: string }[];
    tasks: KanbanTask[];
    team?: any;
}

const DEFAULT_STATUS_PROPAGATION: StatusPropagation = {
    autoCompleteParent: true,
    blockParentOnBlocked: true,
    cascadeDeleteSubtasks: false
};

// Default Kanban columns for new team artifacts
const DEFAULT_COLUMNS = [
    { id: 'todo', title: 'To Do' },
    { id: 'in-progress', title: 'In Progress' },
    { id: 'review', title: 'Review' },
    { id: 'done', title: 'Done' }
];

export class TaskStateManager {
    private api: ApiClient;
    private teamId: string;
    private sessionId: string;
    private roleId?: string;
    private onStateChange?: StateChangeCallback;

    constructor(api: ApiClient, teamId: string, sessionId: string, roleId?: string) {
        this.api = api;
        this.teamId = teamId;
        this.sessionId = sessionId;
        this.roleId = roleId;
    }

    /**
     * Set the role ID for this manager (used for filtering)
     */
    setRoleId(roleId: string): void {
        this.roleId = roleId;
    }

    /**
     * Set the state change callback for broadcasting updates
     */
    setOnStateChange(callback: StateChangeCallback): void {
        this.onStateChange = callback;
    }

    /**
     * Broadcast a state change to listeners and optionally send team message
     */
    private broadcastChange(change: Omit<KanbanStateChange, 'timestamp' | 'triggeredBy'>): void {
        const fullChange: KanbanStateChange = {
            ...change,
            triggeredBy: this.sessionId,
            timestamp: Date.now()
        };

        // Call local callback if set
        if (this.onStateChange) {
            try {
                this.onStateChange(fullChange);
            } catch (err) {
                logger.debug('[TaskStateManager] Error in state change callback:', err);
            }
        }

        // Send team message for state change (fire and forget)
        this.sendStateChangeMessage(fullChange).catch(err => {
            logger.debug('[TaskStateManager] Failed to broadcast state change:', err);
        });
    }

    /**
     * Send a team message about the state change
     */
    private async sendStateChangeMessage(change: KanbanStateChange): Promise<void> {
        const message = this.formatStateChangeMessage(change);

        await this.api.sendTeamMessage(this.teamId, {
            id: randomUUID(),
            teamId: this.teamId,
            type: 'task-update',
            content: message,
            fromSessionId: this.sessionId,
            fromRole: this.roleId,
            timestamp: change.timestamp,
            metadata: {
                taskId: change.taskId,
                changeType: change.type,
                ...change.details
            }
        });
    }

    /**
     * Format a human-readable message for a state change
     */
    private formatStateChangeMessage(change: KanbanStateChange): string {
        const roleLabel = this.roleId ? `[${this.roleId}]` : '';

        switch (change.type) {
            case 'task-created':
                return `${roleLabel} Created task: "${change.taskTitle}"`;
            case 'task-status-changed':
                return `${roleLabel} Task "${change.taskTitle}" → ${change.details.newStatus}`;
            case 'task-assigned':
                return `${roleLabel} Assigned "${change.taskTitle}" to ${change.details.assigneeId}`;
            case 'subtask-created':
                return `${roleLabel} Created subtask "${change.taskTitle}" under "${change.details.parentTitle}"`;
            case 'blocker-reported':
                return `${roleLabel} ⚠️ BLOCKED: "${change.taskTitle}" - ${change.details.description}`;
            case 'blocker-resolved':
                return `${roleLabel} ✅ Resolved blocker on "${change.taskTitle}"`;
            case 'execution-started':
                return `${roleLabel} Started working on "${change.taskTitle}"`;
            case 'execution-completed':
                return `${roleLabel} ✅ Completed "${change.taskTitle}"`;
            default:
                return `${roleLabel} Updated task: "${change.taskTitle}"`;
        }
    }

    /**
     * Get the full Kanban board (via server API)
     * Includes lazy initialization: automatically creates team artifact if it doesn't exist
     */
    async getBoard(): Promise<KanbanBoard> {
        // Step 1: Ensure artifact exists (lazy initialization)
        // This MUST happen BEFORE calling server API, because server requires artifact to exist
        await this.ensureArtifactExists();

        // Step 2: Now use server API (artifact is guaranteed to exist)
        try {
            const result = await this.api.listTasks(this.teamId);
            return {
                columns: DEFAULT_COLUMNS,
                tasks: result.tasks
            };
        } catch (error) {
            // Fallback to artifact if server API fails for other reasons
            logger.debug('[TaskStateManager] Server API failed, falling back to artifact:', error);
            const artifact = await this.api.getArtifact(this.teamId);
            return this.parseBoard(artifact);
        }
    }

    /**
     * Ensure team artifact exists, create if not
     * This is the key to CLI-first workflow - no need for Kanban UI
     */
    private async ensureArtifactExists(): Promise<void> {
        try {
            // Try to get artifact - if it exists, we're done
            await this.api.getArtifact(this.teamId);
            logger.debug('[TaskStateManager] Team artifact exists');
        } catch (error) {
            // Artifact doesn't exist - perform lazy initialization
            logger.debug('[TaskStateManager] Team artifact not found, performing lazy initialization...');
            await this.initializeTeamArtifact();
        }
    }

    /**
     * Lazy initialization: Create team artifact if it doesn't exist
     * This enables CLI agents to work with teams without requiring Kanban UI initialization
     */
    private async initializeTeamArtifact(): Promise<void> {
        const initialHeader = {
            type: 'team',
            name: `Team ${this.teamId.substring(0, 8)}`,
            createdAt: Date.now()
        };
        const initialBody = {
            body: JSON.stringify({
                tasks: [],
                columns: DEFAULT_COLUMNS,
                members: [],
                createdAt: Date.now()
            })
        };

        try {
            await this.api.createArtifact(this.teamId, initialHeader, initialBody);
            logger.debug(`[TaskStateManager] Successfully initialized team artifact ${this.teamId}`);
        } catch (createError) {
            logger.debug(`[TaskStateManager] Failed to initialize team artifact:`, createError);
            throw new Error(`Failed to initialize team artifact: ${createError instanceof Error ? createError.message : 'Unknown error'}`);
        }
    }

    /**
     * Get filtered Kanban context for the current role
     * This is the main method for getting context to inject into prompts
     */
    async getFilteredContext(): Promise<KanbanContext> {
        const board = await this.getBoard();
        const roleId = this.roleId || 'builder'; // Default to builder if no role set

        return filterTasksForRole(
            board.tasks as KanbanTask[],
            roleId,
            this.sessionId
        );
    }

    /**
     * 解析 Artifact 获取 Board
     */
    private parseBoard(artifact: any): KanbanBoard {
        let board: KanbanBoard = { columns: [], tasks: [] };
        if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
            const bodyValue = (artifact.body as { body?: unknown }).body;
            if (typeof bodyValue === 'string') {
                try {
                    board = JSON.parse(bodyValue);
                } catch (e) { /* ignore */ }
            } else if (bodyValue && typeof bodyValue === 'object') {
                board = bodyValue as KanbanBoard;
            }
        } else if (artifact.body) {
            board = artifact.body;
        }
        if (!board.tasks) board.tasks = [];
        if (!board.columns) board.columns = [];
        return board;
    }

    /**
     * 保存 Board 到 Artifact
     */
    private async saveBoard(artifact: any, board: KanbanBoard): Promise<void> {
        const newBody = { body: JSON.stringify(board) };
        await this.api.updateArtifact(
            this.teamId,
            artifact.header,
            newBody,
            artifact.headerVersion,
            artifact.bodyVersion
        );
    }

    /**
     * 获取任务
     */
    async getTask(taskId: string): Promise<KanbanTask | null> {
        const artifact = await this.api.getArtifact(this.teamId);
        const board = this.parseBoard(artifact);
        return board.tasks.find(t => t.id === taskId) || null;
    }

    /**
     * 创建子任务
     */
    async createSubtask(
        parentTaskId: string,
        title: string,
        options: {
            description?: string;
            assigneeId?: string;
            priority?: 'low' | 'medium' | 'high' | 'urgent';
        } = {}
    ): Promise<{ success: boolean; subtask?: KanbanTask; error?: string }> {
        try {
            const artifact = await this.api.getArtifact(this.teamId);
            const board = this.parseBoard(artifact);

            const parentTask = board.tasks.find(t => t.id === parentTaskId);
            if (!parentTask) {
                return { success: false, error: `Parent task ${parentTaskId} not found` };
            }

            const parentDepth = parentTask.depth ?? 0;
            if (parentDepth >= 3) {
                return { success: false, error: 'Maximum nesting depth (3) reached' };
            }

            const subtaskId = randomUUID();
            const subtask: KanbanTask = {
                id: subtaskId,
                title,
                description: options.description,
                status: 'todo',
                assigneeId: options.assigneeId ?? parentTask.assigneeId,
                reporterId: this.sessionId,
                priority: options.priority ?? parentTask.priority,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                parentTaskId,
                subtaskIds: [],
                depth: parentDepth + 1,
                statusPropagation: { ...DEFAULT_STATUS_PROPAGATION }
            };

            // 添加子任务
            board.tasks.push(subtask);

            // 更新父任务的 subtaskIds
            parentTask.subtaskIds = parentTask.subtaskIds || [];
            parentTask.subtaskIds.push(subtaskId);
            parentTask.updatedAt = Date.now();

            // 如果父任务是 todo，自动变为 in-progress
            if (parentTask.status === 'todo') {
                parentTask.status = 'in-progress';
            }

            await this.saveBoard(artifact, board);
            logger.debug(`[TaskStateManager] Created subtask ${subtaskId} under ${parentTaskId}`);

            // Broadcast the change
            this.broadcastChange({
                type: 'subtask-created',
                taskId: subtaskId,
                taskTitle: title,
                details: {
                    parentTaskId,
                    parentTitle: parentTask.title,
                    assigneeId: subtask.assigneeId,
                    priority: subtask.priority
                }
            });

            return { success: true, subtask };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    /**
     * 列出子任务
     */
    async listSubtasks(parentTaskId: string): Promise<KanbanTask[]> {
        const artifact = await this.api.getArtifact(this.teamId);
        const board = this.parseBoard(artifact);
        const parent = board.tasks.find(t => t.id === parentTaskId);
        if (!parent?.subtaskIds?.length) return [];

        return board.tasks.filter(t => parent.subtaskIds!.includes(t.id));
    }

    /**
     * 开始执行任务 - 通过 Server API
     */
    async startTask(taskId: string): Promise<{ success: boolean; error?: string }> {
        try {
            // Use server API - server handles all logic and broadcasts
            const result = await this.api.startTask(
                this.teamId,
                taskId,
                this.sessionId,
                this.roleId || 'builder'
            );

            if (result.success) {
                logger.debug(`[TaskStateManager] Started task ${taskId} via server`);

                // Broadcast locally (server already broadcasted via WebSocket)
                this.broadcastChange({
                    type: 'execution-started',
                    taskId,
                    taskTitle: result.task?.title || taskId,
                    details: {
                        previousStatus: 'todo',
                        newStatus: 'in-progress'
                    }
                });

                return { success: true };
            }

            return { success: false, error: 'Server returned failure' };
        } catch (error: any) {
            logger.debug(`[TaskStateManager] Failed to start task via server:`, error);
            return { success: false, error: error.message || String(error) };
        }
    }

    /**
     * 完成任务 - 通过 Server API (server handles status propagation)
     */
    async completeTask(taskId: string): Promise<{ success: boolean; propagatedTasks?: string[]; error?: string }> {
        try {
            // Use server API - server handles status propagation
            const result = await this.api.completeTask(
                this.teamId,
                taskId,
                this.sessionId
            );

            if (result.success) {
                logger.debug(`[TaskStateManager] Completed task ${taskId} via server`);

                // Broadcast locally
                this.broadcastChange({
                    type: 'execution-completed',
                    taskId,
                    taskTitle: result.task?.title || taskId,
                    details: {
                        previousStatus: 'in-progress',
                        newStatus: 'done',
                        propagatedTasks: [taskId]
                    }
                });

                return { success: true, propagatedTasks: [taskId] };
            }

            return { success: false, error: 'Server returned failure' };
        } catch (error: any) {
            logger.debug(`[TaskStateManager] Failed to complete task via server:`, error);
            return { success: false, error: error.message || String(error) };
        }
    }

    /**
     * 向上传播完成状态
     */
    private propagateCompletionToParent(
        board: KanbanBoard,
        parentTaskId: string,
        accumulator: string[]
    ): { changed: string[] } {
        const parent = board.tasks.find(t => t.id === parentTaskId);
        if (!parent) return { changed: [] };

        // 检查所有子任务是否完成
        const subtasks = board.tasks.filter(t => parent.subtaskIds?.includes(t.id));
        const allDone = subtasks.every(st => st.status === 'done');

        if (allDone && parent.status !== 'done' && parent.status !== 'review') {
            parent.status = 'review';  // 子任务全部完成 → 父任务进入 review
            parent.updatedAt = Date.now();
            accumulator.push(parentTaskId);

            // 递归向上传播
            if (parent.parentTaskId) {
                const parentPropagation = parent.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
                if (parentPropagation.autoCompleteParent) {
                    this.propagateCompletionToParent(board, parent.parentTaskId, accumulator);
                }
            }
        }

        return { changed: accumulator };
    }

    /**
     * 报告阻塞 - 通过 Server API
     */
    async reportBlocker(
        taskId: string,
        type: 'dependency' | 'question' | 'resource' | 'technical',
        description: string
    ): Promise<{ success: boolean; blockerId?: string; error?: string }> {
        try {
            // Use server API - server handles blocker propagation
            const result = await this.api.reportBlocker(
                this.teamId,
                taskId,
                this.sessionId,
                type,
                description
            );

            if (result.success) {
                const blockerId = result.task?.blockers?.[result.task.blockers.length - 1]?.id;
                logger.debug(`[TaskStateManager] Reported blocker ${blockerId} on task ${taskId} via server`);

                // Broadcast locally
                this.broadcastChange({
                    type: 'blocker-reported',
                    taskId,
                    taskTitle: result.task?.title || taskId,
                    details: {
                        blockerId,
                        blockerType: type,
                        description,
                        previousStatus: 'in-progress',
                        newStatus: 'blocked'
                    }
                });

                return { success: true, blockerId };
            }

            return { success: false, error: 'Server returned failure' };
        } catch (error: any) {
            logger.debug(`[TaskStateManager] Failed to report blocker via server:`, error);
            return { success: false, error: error.message || String(error) };
        }
    }

    /**
     * 向上传播阻塞标记
     */
    private propagateBlockerToParent(board: KanbanBoard, parentTaskId: string): void {
        const parent = board.tasks.find(t => t.id === parentTaskId);
        if (!parent) return;

        parent.hasBlockedChild = true;
        parent.updatedAt = Date.now();

        // 继续向上传播
        if (parent.parentTaskId) {
            const propagation = parent.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
            if (propagation.blockParentOnBlocked) {
                this.propagateBlockerToParent(board, parent.parentTaskId);
            }
        }
    }

    /**
     * 解决阻塞
     */
    async resolveBlocker(
        taskId: string,
        blockerId: string,
        resolution: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const artifact = await this.api.getArtifact(this.teamId);
            const board = this.parseBoard(artifact);
            const task = board.tasks.find(t => t.id === taskId);

            if (!task) {
                return { success: false, error: `Task ${taskId} not found` };
            }

            const blocker = task.blockers?.find(b => b.id === blockerId);
            if (!blocker) {
                return { success: false, error: `Blocker ${blockerId} not found` };
            }

            blocker.resolvedAt = Date.now();
            blocker.resolvedBy = this.sessionId;
            blocker.resolution = resolution;

            // 检查是否还有其他未解决的 blocker
            const unresolvedBlockers = task.blockers?.filter(b => !b.resolvedAt) || [];
            if (unresolvedBlockers.length === 0) {
                task.status = 'in-progress';  // 恢复进行中
            }
            task.updatedAt = Date.now();

            // 更新父任务的 hasBlockedChild 标记
            if (task.parentTaskId) {
                this.updateParentBlockedStatus(board, task.parentTaskId);
            }

            await this.saveBoard(artifact, board);
            logger.debug(`[TaskStateManager] Resolved blocker ${blockerId} on task ${taskId}`);

            // Broadcast the change
            this.broadcastChange({
                type: 'blocker-resolved',
                taskId,
                taskTitle: task.title,
                details: {
                    blockerId,
                    resolution,
                    unresolvedCount: unresolvedBlockers.length,
                    newStatus: unresolvedBlockers.length === 0 ? 'in-progress' : 'blocked'
                }
            });

            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    /**
     * 更新父任务的阻塞状态
     */
    private updateParentBlockedStatus(board: KanbanBoard, parentTaskId: string): void {
        const parent = board.tasks.find(t => t.id === parentTaskId);
        if (!parent) return;

        // 检查是否还有子任务被阻塞
        const subtasks = board.tasks.filter(t => parent.subtaskIds?.includes(t.id));
        const hasBlockedSubtask = subtasks.some(st =>
            st.status === 'blocked' || st.hasBlockedChild
        );

        parent.hasBlockedChild = hasBlockedSubtask;
        parent.updatedAt = Date.now();

        // 继续向上更新
        if (parent.parentTaskId) {
            this.updateParentBlockedStatus(board, parent.parentTaskId);
        }
    }

    /**
     * 获取我的活跃任务
     */
    async getMyActiveTasks(): Promise<KanbanTask[]> {
        const artifact = await this.api.getArtifact(this.teamId);
        const board = this.parseBoard(artifact);

        return board.tasks.filter(t =>
            t.assigneeId === this.sessionId &&
            ['todo', 'in-progress'].includes(t.status)
        );
    }

    /**
     * 获取任务树（包含所有子任务）
     */
    async getTaskTree(taskId: string): Promise<KanbanTask[]> {
        const artifact = await this.api.getArtifact(this.teamId);
        const board = this.parseBoard(artifact);

        const result: KanbanTask[] = [];
        const collectSubtasks = (tid: string) => {
            const task = board.tasks.find(t => t.id === tid);
            if (!task) return;
            result.push(task);
            task.subtaskIds?.forEach(stid => collectSubtasks(stid));
        };

        collectSubtasks(taskId);
        return result;
    }

    /**
     * Handle incoming task event from WebSocket (server broadcast)
     * This is called when server pushes task updates
     */
    handleTaskEvent(event: {
        type: 'task-created' | 'task-updated' | 'task-deleted';
        teamId: string;
        taskId: string;
        task?: KanbanTask;
    }): void {
        if (event.teamId !== this.teamId) {
            return; // Ignore events for other teams
        }

        logger.debug(`[TaskStateManager] Received task event: ${event.type} for ${event.taskId}`);

        // Broadcast to local listeners
        switch (event.type) {
            case 'task-created':
                if (event.task) {
                    this.broadcastChange({
                        type: 'task-created',
                        taskId: event.taskId,
                        taskTitle: event.task.title,
                        details: { task: event.task }
                    });
                }
                break;
            case 'task-updated':
                if (event.task) {
                    this.broadcastChange({
                        type: 'task-updated',
                        taskId: event.taskId,
                        taskTitle: event.task.title,
                        details: { task: event.task }
                    });
                }
                break;
            case 'task-deleted':
                this.broadcastChange({
                    type: 'task-deleted',
                    taskId: event.taskId,
                    taskTitle: event.taskId,
                    details: {}
                });
                break;
        }
    }
}
