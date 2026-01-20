/**
 * Status Reporter Module
 *
 * Provides automatic status reporting for team members.
 * This module handles:
 * - Task start/progress/completion reporting
 * - Blocker reporting with help requests
 * - Periodic status summaries
 * - Activity logging for team visibility
 */

import { randomUUID } from 'crypto';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { TaskStateManager } from '../utils/taskStateManager';

// === Types ===

export type StatusAction =
    | 'started'
    | 'progress'
    | 'blocked'
    | 'unblocked'
    | 'completed'
    | 'paused'
    | 'resumed';

export interface StatusUpdate {
    taskId: string;
    action: StatusAction;
    message: string;
    progress?: number;  // 0-100 percentage
    details?: Record<string, any>;
}

export interface BlockerReport {
    taskId: string;
    type: 'dependency' | 'question' | 'resource' | 'technical';
    description: string;
    suggestedHelpers?: string[];
}

export interface StatusSummary {
    roleId: string;
    sessionId: string;
    timestamp: number;
    tasksInProgress: number;
    tasksCompleted: number;
    blockedTasks: number;
    recentActivity: string[];
}

// === Status Reporter Class ===

export class StatusReporter {
    private api: ApiClient;
    private taskManager: TaskStateManager;
    private teamId: string;
    private sessionId: string;
    private roleId: string;
    private activityLog: string[] = [];
    private maxActivityLogSize = 20;

    constructor(
        api: ApiClient,
        taskManager: TaskStateManager,
        teamId: string,
        sessionId: string,
        roleId: string
    ) {
        this.api = api;
        this.taskManager = taskManager;
        this.teamId = teamId;
        this.sessionId = sessionId;
        this.roleId = roleId;
    }

    /**
     * Report that work has started on a task
     */
    async reportTaskStarted(
        taskId: string,
        message?: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            // Update task state
            await this.taskManager.startTask(taskId);

            // Log and send status update
            const statusMessage = message || `Started working on task`;
            await this.sendStatusUpdate({
                taskId,
                action: 'started',
                message: statusMessage
            });

            this.logActivity(`Started: ${taskId}`);
            return { success: true };
        } catch (error) {
            logger.debug('[StatusReporter] Failed to report task started:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Report progress on a task
     */
    async reportProgress(
        taskId: string,
        message: string,
        progress?: number
    ): Promise<{ success: boolean; error?: string }> {
        try {
            await this.sendStatusUpdate({
                taskId,
                action: 'progress',
                message,
                progress
            });

            this.logActivity(`Progress on ${taskId}: ${message}`);
            return { success: true };
        } catch (error) {
            logger.debug('[StatusReporter] Failed to report progress:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Report a blocker on a task
     */
    async reportBlocked(
        taskId: string,
        blocker: BlockerReport
    ): Promise<{ success: boolean; blockerId?: string; error?: string }> {
        try {
            // Update task state with blocker
            const result = await this.taskManager.reportBlocker(
                taskId,
                blocker.type,
                blocker.description
            );

            if (!result.success) {
                return { success: false, error: result.error };
            }

            // Send status update
            await this.sendStatusUpdate({
                taskId,
                action: 'blocked',
                message: blocker.description,
                details: {
                    blockerType: blocker.type,
                    blockerId: result.blockerId
                }
            });

            // Send help request if helpers suggested
            if (blocker.suggestedHelpers && blocker.suggestedHelpers.length > 0) {
                await this.sendHelpRequest(taskId, blocker);
            }

            this.logActivity(`BLOCKED: ${taskId} - ${blocker.description}`);
            return { success: true, blockerId: result.blockerId };
        } catch (error) {
            logger.debug('[StatusReporter] Failed to report blocker:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Report that a blocker has been resolved
     */
    async reportUnblocked(
        taskId: string,
        blockerId: string,
        resolution: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            // Update task state
            await this.taskManager.resolveBlocker(taskId, blockerId, resolution);

            // Send status update
            await this.sendStatusUpdate({
                taskId,
                action: 'unblocked',
                message: resolution,
                details: { blockerId }
            });

            this.logActivity(`Unblocked: ${taskId}`);
            return { success: true };
        } catch (error) {
            logger.debug('[StatusReporter] Failed to report unblocked:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Report task completion
     */
    async reportComplete(
        taskId: string,
        summary: string
    ): Promise<{ success: boolean; propagatedTasks?: string[]; error?: string }> {
        try {
            // Update task state
            const result = await this.taskManager.completeTask(taskId);

            if (!result.success) {
                return { success: false, error: result.error };
            }

            // Send status update
            await this.sendStatusUpdate({
                taskId,
                action: 'completed',
                message: summary,
                progress: 100,
                details: { propagatedTasks: result.propagatedTasks }
            });

            this.logActivity(`✅ Completed: ${taskId}`);
            return { success: true, propagatedTasks: result.propagatedTasks };
        } catch (error) {
            logger.debug('[StatusReporter] Failed to report completion:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Report that work has been paused on a task
     */
    async reportPaused(
        taskId: string,
        reason: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            await this.sendStatusUpdate({
                taskId,
                action: 'paused',
                message: reason
            });

            this.logActivity(`Paused: ${taskId} - ${reason}`);
            return { success: true };
        } catch (error) {
            logger.debug('[StatusReporter] Failed to report paused:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Report that work has resumed on a task
     */
    async reportResumed(
        taskId: string,
        message?: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const statusMessage = message || 'Resumed work on task';
            await this.sendStatusUpdate({
                taskId,
                action: 'resumed',
                message: statusMessage
            });

            this.logActivity(`Resumed: ${taskId}`);
            return { success: true };
        } catch (error) {
            logger.debug('[StatusReporter] Failed to report resumed:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Generate and send a status summary
     */
    async sendStatusSummary(): Promise<{ success: boolean; error?: string }> {
        try {
            const context = await this.taskManager.getFilteredContext();

            const summary: StatusSummary = {
                roleId: this.roleId,
                sessionId: this.sessionId,
                timestamp: Date.now(),
                tasksInProgress: context.myTasks.filter(t => t.status === 'in-progress').length,
                tasksCompleted: context.teamStats.done,
                blockedTasks: context.myTasks.filter(t => t.status === 'blocked').length,
                recentActivity: this.activityLog.slice(-5)
            };

            const content = this.formatStatusSummary(summary, context.myTasks);

            await this.api.sendTeamMessage(this.teamId, {
                id: randomUUID(),
                teamId: this.teamId,
                type: 'task-update',
                content,
                fromSessionId: this.sessionId,
                fromRole: this.roleId,
                timestamp: Date.now(),
                metadata: {
                    messageType: 'status-summary',
                    tasksInProgress: summary.tasksInProgress,
                    tasksCompleted: summary.tasksCompleted,
                    blockedTasks: summary.blockedTasks
                }
            });

            logger.debug('[StatusReporter] Sent status summary');
            return { success: true };
        } catch (error) {
            logger.debug('[StatusReporter] Failed to send status summary:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Get recent activity log
     */
    getActivityLog(): string[] {
        return [...this.activityLog];
    }

    // === Private Methods ===

    /**
     * Send a status update message
     */
    private async sendStatusUpdate(update: StatusUpdate): Promise<void> {
        const content = this.formatStatusUpdate(update);

        await this.api.sendTeamMessage(this.teamId, {
            id: randomUUID(),
            teamId: this.teamId,
            type: 'task-update',
            content,
            fromSessionId: this.sessionId,
            fromRole: this.roleId,
            timestamp: Date.now(),
            metadata: {
                taskId: update.taskId,
                action: update.action,
                progress: update.progress,
                ...update.details
            }
        });
    }

    /**
     * Send a help request message
     */
    private async sendHelpRequest(taskId: string, blocker: BlockerReport): Promise<void> {
        const helpers = blocker.suggestedHelpers || ['master', 'orchestrator'];
        const mentions = helpers.map(h => `@${h}`).join(' ');

        const content = `
🆘 **Help Needed**

**Task ID:** ${taskId}
**Blocker Type:** ${blocker.type}
**From:** ${this.roleId}

**Problem:**
${blocker.description}

${mentions} Please help resolve this blocker.
`.trim();

        await this.api.sendTeamMessage(this.teamId, {
            id: randomUUID(),
            teamId: this.teamId,
            type: 'help-needed',
            content,
            fromSessionId: this.sessionId,
            fromRole: this.roleId,
            timestamp: Date.now(),
            metadata: {
                taskId,
                blockerType: blocker.type,
                priority: 'high'
            }
        });
    }

    /**
     * Format a status update message
     */
    private formatStatusUpdate(update: StatusUpdate): string {
        const actionEmoji: Record<StatusAction, string> = {
            started: '▶️',
            progress: '📊',
            blocked: '🚫',
            unblocked: '✅',
            completed: '✅',
            paused: '⏸️',
            resumed: '▶️'
        };

        const emoji = actionEmoji[update.action];
        let content = `${emoji} **${update.action.toUpperCase()}** [${this.roleId}]\n`;
        content += `**Task:** ${update.taskId}\n`;
        content += `**Status:** ${update.message}`;

        if (update.progress !== undefined) {
            content += `\n**Progress:** ${update.progress}%`;
        }

        return content;
    }

    /**
     * Format a status summary message
     */
    private formatStatusSummary(
        summary: StatusSummary,
        myTasks: Array<{ id: string; title: string; status: string }>
    ): string {
        let content = `
📋 **Status Summary** [${this.roleId}]

**In Progress:** ${summary.tasksInProgress}
**Completed Today:** ${summary.tasksCompleted}
**Blocked:** ${summary.blockedTasks}
`.trim();

        if (myTasks.length > 0) {
            content += '\n\n**Current Tasks:**';
            myTasks.slice(0, 5).forEach(task => {
                const statusEmoji = task.status === 'in-progress' ? '🔄' :
                    task.status === 'blocked' ? '🚫' :
                        task.status === 'done' ? '✅' : '📋';
                content += `\n${statusEmoji} ${task.title}`;
            });
            if (myTasks.length > 5) {
                content += `\n... and ${myTasks.length - 5} more`;
            }
        }

        if (summary.recentActivity.length > 0) {
            content += '\n\n**Recent Activity:**';
            summary.recentActivity.forEach(activity => {
                content += `\n- ${activity}`;
            });
        }

        return content;
    }

    /**
     * Log an activity
     */
    private logActivity(activity: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.activityLog.push(`[${timestamp}] ${activity}`);

        // Keep log size bounded
        if (this.activityLog.length > this.maxActivityLogSize) {
            this.activityLog = this.activityLog.slice(-this.maxActivityLogSize);
        }
    }
}

// === Factory Function ===

/**
 * Create a StatusReporter instance
 */
export function createStatusReporter(
    api: ApiClient,
    taskManager: TaskStateManager,
    teamId: string,
    sessionId: string,
    roleId: string
): StatusReporter {
    return new StatusReporter(api, taskManager, teamId, sessionId, roleId);
}
