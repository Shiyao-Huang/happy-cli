/**
 * Approval Workflow Module
 *
 * Automates the Master/Orchestrator approval process for tasks.
 * This module handles:
 * - Tracking tasks that require approval
 * - Sending approval request notifications
 * - Processing approvals and rejections
 * - Escalating stale approvals
 */

import { randomUUID } from 'crypto';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { TaskStateManager } from '../utils/taskStateManager';
import { KanbanTaskSummary, COORDINATION_ROLES } from './roles';

// === Types ===

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'not_required';

export interface ApprovalRequest {
    taskId: string;
    taskTitle: string;
    requestedBy: string;
    requestedByRole?: string;
    requestedAt: number;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    context?: string;
    approvalType: 'task-completion' | 'task-creation' | 'scope-change' | 'resource-request';
}

export interface ApprovalDecision {
    taskId: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    decidedByRole: string;
    decidedAt: number;
    reason?: string;
    conditions?: string[];
}

export interface ApprovalWorkflowConfig {
    autoApproveThreshold?: number;  // Auto-approve tasks below this priority (0 = none)
    escalationTimeout?: number;      // Minutes before escalating stale approvals
    requireMultipleApprovers?: boolean;
    minApprovers?: number;
}

const DEFAULT_CONFIG: ApprovalWorkflowConfig = {
    autoApproveThreshold: 0,
    escalationTimeout: 60,
    requireMultipleApprovers: false,
    minApprovers: 1
};

// === Approval Workflow Class ===

export class ApprovalWorkflow {
    private api: ApiClient;
    private taskManager: TaskStateManager;
    private teamId: string;
    private sessionId: string;
    private roleId: string;
    private config: ApprovalWorkflowConfig;
    private pendingRequests: Map<string, ApprovalRequest> = new Map();

    constructor(
        api: ApiClient,
        taskManager: TaskStateManager,
        teamId: string,
        sessionId: string,
        roleId: string,
        config?: Partial<ApprovalWorkflowConfig>
    ) {
        this.api = api;
        this.taskManager = taskManager;
        this.teamId = teamId;
        this.sessionId = sessionId;
        this.roleId = roleId;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Check if this session can approve tasks
     */
    canApprove(): boolean {
        return COORDINATION_ROLES.includes(this.roleId);
    }

    /**
     * Request approval for a task
     */
    async requestApproval(
        taskId: string,
        taskTitle: string,
        approvalType: ApprovalRequest['approvalType'],
        options: {
            priority?: 'low' | 'medium' | 'high' | 'urgent';
            context?: string;
        } = {}
    ): Promise<{ success: boolean; requestId?: string; error?: string }> {
        try {
            const priority = options.priority || 'medium';

            // Check for auto-approval
            const priorityWeight = { low: 1, medium: 2, high: 3, urgent: 4 };
            if (this.config.autoApproveThreshold &&
                priorityWeight[priority] < this.config.autoApproveThreshold) {
                logger.debug(`[ApprovalWorkflow] Auto-approving ${taskId} (priority below threshold)`);
                return { success: true, requestId: 'auto-approved' };
            }

            const request: ApprovalRequest = {
                taskId,
                taskTitle,
                requestedBy: this.sessionId,
                requestedByRole: this.roleId,
                requestedAt: Date.now(),
                priority,
                context: options.context,
                approvalType
            };

            // Store the request
            this.pendingRequests.set(taskId, request);

            // Send approval request message
            await this.sendApprovalRequestMessage(request);

            logger.debug(`[ApprovalWorkflow] Requested approval for task ${taskId}`);
            return { success: true, requestId: taskId };
        } catch (error) {
            logger.debug('[ApprovalWorkflow] Failed to request approval:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Approve a task
     */
    async approveTask(
        taskId: string,
        options: {
            reason?: string;
            conditions?: string[];
        } = {}
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.canApprove()) {
            return { success: false, error: 'This role cannot approve tasks' };
        }

        try {
            const decision: ApprovalDecision = {
                taskId,
                decision: 'approved',
                decidedBy: this.sessionId,
                decidedByRole: this.roleId,
                decidedAt: Date.now(),
                reason: options.reason,
                conditions: options.conditions
            };

            // Remove from pending
            const request = this.pendingRequests.get(taskId);
            this.pendingRequests.delete(taskId);

            // Send approval notification
            await this.sendApprovalDecisionMessage(decision, request);

            logger.debug(`[ApprovalWorkflow] Approved task ${taskId}`);
            return { success: true };
        } catch (error) {
            logger.debug('[ApprovalWorkflow] Failed to approve task:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Reject a task
     */
    async rejectTask(
        taskId: string,
        reason: string,
        options: {
            suggestedChanges?: string[];
        } = {}
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.canApprove()) {
            return { success: false, error: 'This role cannot reject tasks' };
        }

        try {
            const decision: ApprovalDecision = {
                taskId,
                decision: 'rejected',
                decidedBy: this.sessionId,
                decidedByRole: this.roleId,
                decidedAt: Date.now(),
                reason,
                conditions: options.suggestedChanges
            };

            // Remove from pending
            const request = this.pendingRequests.get(taskId);
            this.pendingRequests.delete(taskId);

            // Send rejection notification
            await this.sendApprovalDecisionMessage(decision, request);

            logger.debug(`[ApprovalWorkflow] Rejected task ${taskId}: ${reason}`);
            return { success: true };
        } catch (error) {
            logger.debug('[ApprovalWorkflow] Failed to reject task:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Process the approval queue (for coordinators)
     */
    async processApprovalQueue(): Promise<{
        pending: ApprovalRequest[];
        stale: ApprovalRequest[];
    }> {
        const now = Date.now();
        const escalationMs = (this.config.escalationTimeout || 60) * 60 * 1000;

        const pending: ApprovalRequest[] = [];
        const stale: ApprovalRequest[] = [];

        for (const [taskId, request] of this.pendingRequests) {
            const age = now - request.requestedAt;

            if (age > escalationMs) {
                stale.push(request);
            } else {
                pending.push(request);
            }
        }

        // Escalate stale requests
        for (const staleRequest of stale) {
            await this.escalateRequest(staleRequest);
        }

        return { pending, stale };
    }

    /**
     * Get pending approvals from the Kanban board
     */
    async getPendingApprovalsFromBoard(): Promise<KanbanTaskSummary[]> {
        const context = await this.taskManager.getFilteredContext();
        return context.pendingApprovals || [];
    }

    // === Private Methods ===

    /**
     * Send approval request message to team
     */
    private async sendApprovalRequestMessage(request: ApprovalRequest): Promise<void> {
        const priorityEmoji = {
            low: '🟢',
            medium: '🟡',
            high: '🟠',
            urgent: '🔴'
        };

        const typeLabel = {
            'task-completion': 'Task Completion',
            'task-creation': 'New Task',
            'scope-change': 'Scope Change',
            'resource-request': 'Resource Request'
        };

        const content = `
📋 **Approval Required** ${priorityEmoji[request.priority]}

**Type:** ${typeLabel[request.approvalType]}
**Task:** ${request.taskTitle}
**Requested by:** ${request.requestedByRole || 'Unknown'} (${request.requestedBy.substring(0, 8)})
**Priority:** ${request.priority.toUpperCase()}

${request.context ? `**Context:** ${request.context}` : ''}

@master @orchestrator Please review and approve/reject this request.
`.trim();

        await this.api.sendTeamMessage(this.teamId, {
            id: randomUUID(),
            teamId: this.teamId,
            type: 'notification',
            content,
            fromSessionId: this.sessionId,
            fromRole: this.roleId,
            timestamp: Date.now(),
            metadata: {
                taskId: request.taskId,
                approvalType: request.approvalType,
                priority: request.priority,
                requestType: 'approval-request'
            }
        });
    }

    /**
     * Send approval decision message
     */
    private async sendApprovalDecisionMessage(
        decision: ApprovalDecision,
        request?: ApprovalRequest
    ): Promise<void> {
        const isApproved = decision.decision === 'approved';
        const emoji = isApproved ? '✅' : '❌';
        const action = isApproved ? 'APPROVED' : 'REJECTED';

        let content = `
${emoji} **${action}**

**Task ID:** ${decision.taskId}
**Decided by:** ${decision.decidedByRole} (${decision.decidedBy.substring(0, 8)})
`.trim();

        if (decision.reason) {
            content += `\n**Reason:** ${decision.reason}`;
        }

        if (decision.conditions && decision.conditions.length > 0) {
            const label = isApproved ? 'Conditions' : 'Suggested Changes';
            content += `\n**${label}:**\n${decision.conditions.map(c => `- ${c}`).join('\n')}`;
        }

        // Notify the original requester
        const mentions = request?.requestedBy ? [request.requestedBy] : [];

        await this.api.sendTeamMessage(this.teamId, {
            id: randomUUID(),
            teamId: this.teamId,
            type: 'notification',
            content,
            mentions,
            fromSessionId: this.sessionId,
            fromRole: this.roleId,
            timestamp: Date.now(),
            metadata: {
                taskId: decision.taskId,
                decision: decision.decision,
                requestType: 'approval-decision'
            }
        });
    }

    /**
     * Escalate a stale approval request
     */
    private async escalateRequest(request: ApprovalRequest): Promise<void> {
        const ageMinutes = Math.floor((Date.now() - request.requestedAt) / 60000);

        const content = `
⚠️ **ESCALATION: Stale Approval Request**

**Task:** ${request.taskTitle}
**Waiting:** ${ageMinutes} minutes
**Original Priority:** ${request.priority.toUpperCase()}

This approval request has been waiting too long. Please review immediately.

@master @orchestrator
`.trim();

        await this.api.sendTeamMessage(this.teamId, {
            id: randomUUID(),
            teamId: this.teamId,
            type: 'notification',
            content,
            fromSessionId: this.sessionId,
            fromRole: this.roleId,
            timestamp: Date.now(),
            metadata: {
                taskId: request.taskId,
                priority: 'urgent',
                requestType: 'escalation'
            }
        });

        logger.debug(`[ApprovalWorkflow] Escalated stale request for task ${request.taskId}`);
    }
}

// === Helper Functions ===

/**
 * Create an ApprovalWorkflow instance with common defaults
 */
export function createApprovalWorkflow(
    api: ApiClient,
    taskManager: TaskStateManager,
    teamId: string,
    sessionId: string,
    roleId: string
): ApprovalWorkflow {
    return new ApprovalWorkflow(api, taskManager, teamId, sessionId, roleId);
}

/**
 * Check if a task requires approval based on its properties
 */
export function requiresApproval(task: KanbanTaskSummary): boolean {
    // Tasks explicitly marked as requiring approval
    if (task.approvalStatus === 'pending') {
        return true;
    }

    // High priority tasks may require approval
    if (task.priority === 'urgent' || task.priority === 'high') {
        return true;
    }

    return false;
}
