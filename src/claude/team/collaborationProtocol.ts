/**
 * Collaboration Protocol Module
 *
 * Provides standardized collaboration request handling between team roles.
 * This module implements:
 * - Collaboration request creation and sending
 * - Help needed requests
 * - Task handoffs between roles
 * - Role-based collaboration targeting
 */

import { randomUUID } from 'crypto';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { ROLE_COLLABORATION_MAP, COORDINATION_ROLES } from './roles';

// === Types (mirrored from kanban/sources/sync/teamMessageTypes.ts) ===

export type CollaborationRequestType = 'review' | 'pair' | 'consult' | 'escalate' | 'delegate';
export type CollaborationUrgency = 'low' | 'normal' | 'high' | 'blocking';

export interface CollaborationRequest {
    requestType: CollaborationRequestType;
    taskId: string;
    requestingRole: string;
    targetRoles: string[];
    urgency: CollaborationUrgency;
    context: string;
    expectedOutcome?: string;
}

export interface HelpNeededRequest {
    taskId: string;
    blockerType: 'dependency' | 'question' | 'resource' | 'technical' | 'unknown';
    description: string;
    attemptedSolutions?: string[];
    targetRoles?: string[];
}

export interface HandoffRequest {
    taskId: string;
    fromRole: string;
    toRole: string;
    reason: 'completion' | 'reassignment' | 'escalation' | 'specialization';
    summary: string;
    nextSteps?: string[];
}

// === Collaboration Protocol Class ===

export class CollaborationProtocol {
    private api: ApiClient;
    private teamId: string;
    private sessionId: string;
    private roleId: string;

    constructor(
        api: ApiClient,
        teamId: string,
        sessionId: string,
        roleId: string
    ) {
        this.api = api;
        this.teamId = teamId;
        this.sessionId = sessionId;
        this.roleId = roleId;
    }

    /**
     * Request collaboration from other roles
     */
    async requestCollaboration(
        request: Omit<CollaborationRequest, 'requestingRole'>
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const fullRequest: CollaborationRequest = {
                ...request,
                requestingRole: this.roleId
            };

            // Format the message
            const content = this.formatCollaborationRequest(fullRequest);

            // Get target session IDs (if available)
            const mentions = this.getRoleMentions(request.targetRoles);

            await this.api.sendTeamMessage(this.teamId, {
                id: randomUUID(),
                teamId: this.teamId,
                type: 'collaboration-request',
                content,
                mentions,
                fromSessionId: this.sessionId,
                fromRole: this.roleId,
                timestamp: Date.now(),
                metadata: {
                    taskId: request.taskId,
                    requestType: request.requestType,
                    urgency: request.urgency,
                    targetRoles: request.targetRoles
                }
            });

            logger.debug(`[CollaborationProtocol] Sent collaboration request: ${request.requestType} for task ${request.taskId}`);
            return { success: true };
        } catch (error) {
            logger.debug('[CollaborationProtocol] Failed to send collaboration request:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Request help when blocked
     */
    async requestHelp(request: HelpNeededRequest): Promise<{ success: boolean; error?: string }> {
        try {
            const content = this.formatHelpRequest(request);

            // Target coordinators by default, or specified roles
            const targetRoles = request.targetRoles || COORDINATION_ROLES;
            const mentions = this.getRoleMentions(targetRoles);

            await this.api.sendTeamMessage(this.teamId, {
                id: randomUUID(),
                teamId: this.teamId,
                type: 'help-needed',
                content,
                mentions,
                fromSessionId: this.sessionId,
                fromRole: this.roleId,
                timestamp: Date.now(),
                metadata: {
                    taskId: request.taskId,
                    blockerType: request.blockerType,
                    priority: 'high'
                }
            });

            logger.debug(`[CollaborationProtocol] Sent help request for task ${request.taskId}`);
            return { success: true };
        } catch (error) {
            logger.debug('[CollaborationProtocol] Failed to send help request:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Hand off a task to another role
     */
    async handoffTask(request: Omit<HandoffRequest, 'fromRole'>): Promise<{ success: boolean; error?: string }> {
        try {
            const fullRequest: HandoffRequest = {
                ...request,
                fromRole: this.roleId
            };

            const content = this.formatHandoffRequest(fullRequest);

            // Target the specific role
            const mentions = this.getRoleMentions([request.toRole]);

            await this.api.sendTeamMessage(this.teamId, {
                id: randomUUID(),
                teamId: this.teamId,
                type: 'handoff',
                content,
                mentions,
                fromSessionId: this.sessionId,
                fromRole: this.roleId,
                timestamp: Date.now(),
                metadata: {
                    taskId: request.taskId,
                    toRole: request.toRole,
                    handoffReason: request.reason
                }
            });

            logger.debug(`[CollaborationProtocol] Sent handoff request: ${this.roleId} -> ${request.toRole} for task ${request.taskId}`);
            return { success: true };
        } catch (error) {
            logger.debug('[CollaborationProtocol] Failed to send handoff request:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Request a code review
     */
    async requestReview(
        taskId: string,
        context: string,
        options: {
            urgency?: CollaborationUrgency;
            expectedOutcome?: string;
        } = {}
    ): Promise<{ success: boolean; error?: string }> {
        return this.requestCollaboration({
            requestType: 'review',
            taskId,
            targetRoles: ['reviewer', 'qa-engineer', 'qa'],
            urgency: options.urgency || 'normal',
            context,
            expectedOutcome: options.expectedOutcome || 'Code review feedback and approval'
        });
    }

    /**
     * Request pair programming
     */
    async requestPairing(
        taskId: string,
        context: string,
        targetRoles: string[],
        options: {
            urgency?: CollaborationUrgency;
        } = {}
    ): Promise<{ success: boolean; error?: string }> {
        return this.requestCollaboration({
            requestType: 'pair',
            taskId,
            targetRoles,
            urgency: options.urgency || 'normal',
            context,
            expectedOutcome: 'Collaborative problem-solving and knowledge sharing'
        });
    }

    /**
     * Request consultation from an expert
     */
    async requestConsultation(
        taskId: string,
        context: string,
        targetRoles: string[],
        options: {
            urgency?: CollaborationUrgency;
            question?: string;
        } = {}
    ): Promise<{ success: boolean; error?: string }> {
        return this.requestCollaboration({
            requestType: 'consult',
            taskId,
            targetRoles,
            urgency: options.urgency || 'normal',
            context: options.question ? `${context}\n\nQuestion: ${options.question}` : context,
            expectedOutcome: 'Expert guidance or recommendation'
        });
    }

    /**
     * Escalate an issue to coordinators
     */
    async escalate(
        taskId: string,
        reason: string,
        options: {
            urgency?: CollaborationUrgency;
            recommendedAction?: string;
        } = {}
    ): Promise<{ success: boolean; error?: string }> {
        return this.requestCollaboration({
            requestType: 'escalate',
            taskId,
            targetRoles: COORDINATION_ROLES,
            urgency: options.urgency || 'high',
            context: reason,
            expectedOutcome: options.recommendedAction || 'Decision or intervention from coordinator'
        });
    }

    // === Private Helper Methods ===

    /**
     * Format a collaboration request message
     */
    private formatCollaborationRequest(request: CollaborationRequest): string {
        const urgencyEmoji = {
            low: '🟢',
            normal: '🟡',
            high: '🟠',
            blocking: '🔴'
        };

        const typeLabel = {
            review: '📝 Code Review',
            pair: '👥 Pair Programming',
            consult: '💡 Consultation',
            escalate: '⬆️ Escalation',
            delegate: '➡️ Delegation'
        };

        const targetRolesList = request.targetRoles.map(r => `@${r}`).join(' ');

        return `
${urgencyEmoji[request.urgency]} **${typeLabel[request.requestType]}** Request

**Task ID:** ${request.taskId}
**From:** ${request.requestingRole}
**To:** ${targetRolesList}
**Urgency:** ${request.urgency.toUpperCase()}

**Context:**
${request.context}

${request.expectedOutcome ? `**Expected Outcome:** ${request.expectedOutcome}` : ''}
`.trim();
    }

    /**
     * Format a help request message
     */
    private formatHelpRequest(request: HelpNeededRequest): string {
        const blockerEmoji = {
            dependency: '🔗',
            question: '❓',
            resource: '📦',
            technical: '🔧',
            unknown: '❓'
        };

        let content = `
🆘 **Help Needed** ${blockerEmoji[request.blockerType]}

**Task ID:** ${request.taskId}
**Blocker Type:** ${request.blockerType}
**From:** ${this.roleId}

**Problem:**
${request.description}
`.trim();

        if (request.attemptedSolutions && request.attemptedSolutions.length > 0) {
            content += `\n\n**Already Tried:**\n${request.attemptedSolutions.map(s => `- ${s}`).join('\n')}`;
        }

        content += `\n\n@master @orchestrator Please help resolve this blocker.`;

        return content;
    }

    /**
     * Format a handoff request message
     */
    private formatHandoffRequest(request: HandoffRequest): string {
        const reasonEmoji = {
            completion: '✅',
            reassignment: '🔄',
            escalation: '⬆️',
            specialization: '🎯'
        };

        let content = `
${reasonEmoji[request.reason]} **Task Handoff**

**Task ID:** ${request.taskId}
**From:** @${request.fromRole}
**To:** @${request.toRole}
**Reason:** ${request.reason}

**Summary:**
${request.summary}
`.trim();

        if (request.nextSteps && request.nextSteps.length > 0) {
            content += `\n\n**Suggested Next Steps:**\n${request.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
        }

        return content;
    }

    /**
     * Get role mention strings
     * In the future, this could resolve to actual session IDs
     */
    private getRoleMentions(roles: string[]): string[] {
        // For now, we use role names as mentions
        // The message content includes @role patterns that the message handler can parse
        return roles;
    }
}

// === Factory Function ===

/**
 * Create a CollaborationProtocol instance
 */
export function createCollaborationProtocol(
    api: ApiClient,
    teamId: string,
    sessionId: string,
    roleId: string
): CollaborationProtocol {
    return new CollaborationProtocol(api, teamId, sessionId, roleId);
}

// === Utility Functions ===

/**
 * Get suggested collaborators for a given request type
 */
export function getSuggestedCollaborators(
    requestType: CollaborationRequestType,
    currentRole: string
): string[] {
    switch (requestType) {
        case 'review':
            return ['reviewer', 'qa-engineer', 'qa'];
        case 'pair':
            // Suggest roles that typically work together
            if (['builder', 'implementer'].includes(currentRole)) {
                return ['builder', 'framer', 'architect'];
            }
            if (['framer'].includes(currentRole)) {
                return ['builder', 'ux-designer', 'product-designer'];
            }
            return ['builder', 'framer'];
        case 'consult':
            return ['architect', 'solution-architect', 'researcher'];
        case 'escalate':
            return COORDINATION_ROLES;
        case 'delegate':
            return Object.keys(ROLE_COLLABORATION_MAP);
        default:
            return COORDINATION_ROLES;
    }
}

/**
 * Determine if a role should handle a specific collaboration request type
 */
export function canHandleRequest(
    roleId: string,
    requestType: CollaborationRequestType
): boolean {
    const handlers: Record<CollaborationRequestType, string[]> = {
        review: ['reviewer', 'qa-engineer', 'qa', 'architect'],
        pair: ['builder', 'framer', 'implementer', 'architect'],
        consult: ['architect', 'solution-architect', 'researcher', 'business-analyst'],
        escalate: COORDINATION_ROLES,
        delegate: COORDINATION_ROLES
    };

    return handlers[requestType]?.includes(roleId) ?? false;
}
