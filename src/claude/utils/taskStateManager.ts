/**
 * Task State Manager
 * 
 * 管理嵌套任务的状态传播、执行链接和阻塞追踪
 * 这是多 Agent 协作的核心状态引擎
 */

import { randomUUID } from 'crypto';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';

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

export class TaskStateManager {
    private api: ApiClient;
    private teamId: string;
    private sessionId: string;

    constructor(api: ApiClient, teamId: string, sessionId: string) {
        this.api = api;
        this.teamId = teamId;
        this.sessionId = sessionId;
    }

    /**
     * 解析 Artifact 获取 Board
     */
    private parseBoard(artifact: any): KanbanBoard {
        let board: KanbanBoard = { columns: [], tasks: [] };
        if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
            try {
                board = JSON.parse(artifact.body.body);
            } catch (e) { /* ignore */ }
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
     * 开始执行任务 - 创建执行链接
     */
    async startTask(taskId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const artifact = await this.api.getArtifact(this.teamId);
            const board = this.parseBoard(artifact);
            const task = board.tasks.find(t => t.id === taskId);

            if (!task) {
                return { success: false, error: `Task ${taskId} not found` };
            }

            // 检查是否已有 active 链接
            const existingActive = task.executionLinks?.find(l => l.status === 'active');
            if (existingActive && existingActive.sessionId !== this.sessionId) {
                return { success: false, error: `Task is already being executed by session ${existingActive.sessionId}` };
            }

            // 添加执行链接
            task.executionLinks = task.executionLinks || [];
            task.executionLinks.push({
                sessionId: this.sessionId,
                linkedAt: Date.now(),
                role: 'primary',
                status: 'active'
            });

            // 更新状态
            if (task.status === 'todo') {
                task.status = 'in-progress';
            }
            task.updatedAt = Date.now();

            await this.saveBoard(artifact, board);
            logger.debug(`[TaskStateManager] Started task ${taskId}`);

            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    /**
     * 完成任务 - 触发状态传播
     */
    async completeTask(taskId: string): Promise<{ success: boolean; propagatedTasks?: string[]; error?: string }> {
        try {
            const artifact = await this.api.getArtifact(this.teamId);
            const board = this.parseBoard(artifact);
            const task = board.tasks.find(t => t.id === taskId);

            if (!task) {
                return { success: false, error: `Task ${taskId} not found` };
            }

            // 检查是否有未完成的子任务
            if (task.subtaskIds?.length) {
                const subtasks = board.tasks.filter(t => task.subtaskIds!.includes(t.id));
                const incomplete = subtasks.filter(st => st.status !== 'done');
                if (incomplete.length > 0) {
                    return {
                        success: false,
                        error: `Cannot complete: ${incomplete.length} subtasks still pending`
                    };
                }
            }

            // 更新执行链接状态
            const activeLink = task.executionLinks?.find(l => l.sessionId === this.sessionId && l.status === 'active');
            if (activeLink) {
                activeLink.status = 'completed';
            }

            // 完成任务
            task.status = 'done';
            task.updatedAt = Date.now();

            const propagatedTasks: string[] = [taskId];

            // 状态传播到父任务
            if (task.parentTaskId) {
                const propagation = task.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
                if (propagation.autoCompleteParent) {
                    const result = this.propagateCompletionToParent(board, task.parentTaskId, propagatedTasks);
                    if (result.changed) {
                        propagatedTasks.push(...result.changed);
                    }
                }
            }

            await this.saveBoard(artifact, board);
            logger.debug(`[TaskStateManager] Completed task ${taskId}, propagated: ${propagatedTasks.join(', ')}`);

            return { success: true, propagatedTasks };
        } catch (error) {
            return { success: false, error: String(error) };
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
     * 报告阻塞
     */
    async reportBlocker(
        taskId: string,
        type: 'dependency' | 'question' | 'resource' | 'technical',
        description: string
    ): Promise<{ success: boolean; blockerId?: string; error?: string }> {
        try {
            const artifact = await this.api.getArtifact(this.teamId);
            const board = this.parseBoard(artifact);
            const task = board.tasks.find(t => t.id === taskId);

            if (!task) {
                return { success: false, error: `Task ${taskId} not found` };
            }

            const blockerId = randomUUID();
            const blocker: TaskBlocker = {
                id: blockerId,
                type,
                description,
                raisedAt: Date.now(),
                raisedBy: this.sessionId
            };

            task.blockers = task.blockers || [];
            task.blockers.push(blocker);
            task.status = 'blocked';
            task.updatedAt = Date.now();

            // 向上传播阻塞标记
            if (task.parentTaskId) {
                const propagation = task.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
                if (propagation.blockParentOnBlocked) {
                    this.propagateBlockerToParent(board, task.parentTaskId);
                }
            }

            await this.saveBoard(artifact, board);
            logger.debug(`[TaskStateManager] Reported blocker ${blockerId} on task ${taskId}`);

            return { success: true, blockerId };
        } catch (error) {
            return { success: false, error: String(error) };
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
}
