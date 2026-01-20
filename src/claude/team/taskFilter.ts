/**
 * Task Filter Module
 *
 * Provides role-based task filtering to enable context isolation.
 * Each role only sees tasks relevant to their responsibilities.
 *
 * Key Features:
 * - Filter tasks assigned to a specific session
 * - Filter available tasks by role category
 * - Calculate team statistics
 * - Extract pending approvals for coordinators
 */

import { logger } from '@/ui/logger';
import {
    KanbanContext,
    KanbanTaskSummary,
    COORDINATION_ROLES,
    IMPLEMENTATION_ROLES,
    REVIEW_ROLES,
    RESEARCH_ROLES,
    PRODUCT_ROLES,
    DESIGN_ROLES,
    DOCUMENTATION_ROLES
} from './roles';

/**
 * Role to task category mapping
 * Maps each role to the task labels/categories it should work on
 */
const ROLE_CATEGORY_MAP: Record<string, string[]> = {
    // Implementation roles
    'builder': ['implementation', 'backend', 'coding', 'development', 'feature', 'bugfix'],
    'framer': ['design', 'frontend', 'ui', 'ux', 'component', 'styling'],
    'implementer': ['implementation', 'coding', 'development', 'feature'],
    'architect': ['architecture', 'design', 'technical', 'infrastructure', 'system'],
    'solution-architect': ['architecture', 'solution', 'integration', 'system'],

    // Review/QA roles
    'reviewer': ['review', 'code-review', 'pr', 'audit'],
    'qa-engineer': ['qa', 'testing', 'quality', 'validation', 'test'],
    'qa': ['qa', 'testing', 'quality', 'validation', 'test'],
    'observer': ['observation', 'monitoring', 'analysis'],

    // Research roles
    'researcher': ['research', 'investigation', 'analysis', 'study'],
    'scout': ['research', 'exploration', 'discovery', 'prototype'],
    'ux-researcher': ['ux-research', 'user-study', 'usability', 'interview'],
    'business-analyst': ['business', 'requirements', 'analysis', 'stakeholder'],

    // Product roles
    'product-owner': ['product', 'backlog', 'requirements', 'prioritization'],
    'product-designer': ['product', 'design', 'ux', 'user-experience'],
    'spec-writer': ['specification', 'requirements', 'documentation', 'prd'],

    // Design roles
    'ux-designer': ['ux', 'design', 'user-experience', 'wireframe', 'prototype'],

    // Documentation roles
    'scribe': ['documentation', 'notes', 'meeting', 'summary'],
    'technical-writer': ['documentation', 'api-docs', 'readme', 'guide'],

    // Coordination roles - they see everything
    'master': [],
    'orchestrator': [],
    'project-manager': ['project', 'planning', 'coordination'],
};

/**
 * Raw task type from Kanban board (compatible with taskStateManager types)
 */
export interface KanbanTask {
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
    executionLinks?: Array<{
        sessionId: string;
        linkedAt: number;
        role: 'primary' | 'supporting';
        status: 'active' | 'completed' | 'abandoned';
    }>;
    blockers?: Array<{
        id: string;
        type: 'dependency' | 'question' | 'resource' | 'technical';
        description: string;
        raisedAt: number;
        raisedBy?: string;
        resolvedAt?: number;
        resolvedBy?: string;
        resolution?: string;
    }>;
    labels?: string[];
    approvalStatus?: 'pending' | 'approved' | 'rejected' | 'not_required';
}

/**
 * Convert a KanbanTask to KanbanTaskSummary for prompt injection
 */
function toTaskSummary(task: KanbanTask): KanbanTaskSummary {
    return {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        blockers: task.blockers?.map(b => ({
            id: b.id,
            type: b.type,
            description: b.description,
            resolvedAt: b.resolvedAt
        })),
        parentTaskId: task.parentTaskId,
        subtaskIds: task.subtaskIds,
        assigneeId: task.assigneeId,
        executionLinks: task.executionLinks?.map(l => ({
            sessionId: l.sessionId,
            status: l.status
        })),
        approvalStatus: task.approvalStatus
    };
}

/**
 * Check if a task matches a role's category
 *
 * @param task - The task to check
 * @param roleId - The role ID to match against
 * @returns true if the task matches the role's categories
 */
function matchesRoleCategory(task: KanbanTask, roleId: string): boolean {
    // Coordinators see all tasks
    if (COORDINATION_ROLES.includes(roleId)) {
        return true;
    }

    const roleCategories = ROLE_CATEGORY_MAP[roleId];

    // If no categories defined for this role, it can see all tasks
    if (!roleCategories || roleCategories.length === 0) {
        return true;
    }

    // If task has no labels, allow it (could be newly created)
    if (!task.labels || task.labels.length === 0) {
        return true;
    }

    // Check if any task label matches role categories
    const taskLabelsLower = task.labels.map(l => l.toLowerCase());
    return roleCategories.some(cat => taskLabelsLower.includes(cat.toLowerCase()));
}

/**
 * Check if a task is actively being worked on by a session
 */
function isActivelyWorkedBy(task: KanbanTask, sessionId: string): boolean {
    return task.executionLinks?.some(
        link => link.sessionId === sessionId && link.status === 'active'
    ) ?? false;
}

/**
 * Filter tasks for a specific role and session
 *
 * This is the main entry point for task filtering. It provides:
 * - myTasks: Tasks assigned to or actively worked by this session
 * - availableTasks: Unassigned tasks matching the role's category
 * - teamStats: Overall team statistics
 * - pendingApprovals: (Master only) Tasks awaiting approval
 *
 * @param allTasks - All tasks from the Kanban board
 * @param roleId - The role ID to filter for
 * @param sessionId - The session ID to filter for
 * @returns KanbanContext with filtered tasks and statistics
 */
export function filterTasksForRole(
    allTasks: KanbanTask[],
    roleId: string,
    sessionId: string
): KanbanContext {
    logger.debug(`[TaskFilter] Filtering ${allTasks.length} tasks for role: ${roleId}, session: ${sessionId}`);

    const isCoordinator = COORDINATION_ROLES.includes(roleId);

    // My Tasks: Assigned to me OR I have an active execution link
    const myTasks = allTasks.filter(task =>
        task.assigneeId === sessionId ||
        isActivelyWorkedBy(task, sessionId)
    );

    // Available Tasks: Unassigned + matching my role category + status is 'todo'
    let availableTasks: KanbanTask[];

    if (isCoordinator) {
        // Coordinators see all unassigned todo tasks
        availableTasks = allTasks.filter(task =>
            !task.assigneeId &&
            task.status === 'todo'
        );
    } else {
        // Workers see unassigned todo tasks that match their category
        availableTasks = allTasks.filter(task =>
            !task.assigneeId &&
            task.status === 'todo' &&
            matchesRoleCategory(task, roleId)
        );
    }

    // Calculate team statistics
    const teamStats = {
        todo: allTasks.filter(t => t.status === 'todo').length,
        inProgress: allTasks.filter(t => t.status === 'in-progress').length,
        review: allTasks.filter(t => t.status === 'review').length,
        done: allTasks.filter(t => t.status === 'done').length,
        blocked: allTasks.filter(t => t.status === 'blocked').length
    };

    // Pending Approvals: Only for coordinators
    let pendingApprovals: KanbanTaskSummary[] | undefined;
    if (isCoordinator) {
        pendingApprovals = allTasks
            .filter(t => t.approvalStatus === 'pending')
            .map(toTaskSummary);
    }

    // Generate recent activity (last 5 task updates)
    const sortedByUpdate = [...allTasks].sort((a, b) => b.updatedAt - a.updatedAt);
    const recentActivity = sortedByUpdate.slice(0, 5).map(task => {
        const timeAgo = formatTimeAgo(task.updatedAt);
        return `[${timeAgo}] ${task.title} → ${task.status}`;
    });

    const context: KanbanContext = {
        myTasks: myTasks.map(toTaskSummary),
        availableTasks: availableTasks.map(toTaskSummary),
        teamStats,
        pendingApprovals,
        recentActivity
    };

    logger.debug(`[TaskFilter] Result: ${myTasks.length} my tasks, ${availableTasks.length} available, ${pendingApprovals?.length || 0} approvals`);

    return context;
}

/**
 * Get role category for a task based on its labels
 * Useful for task routing decisions
 */
export function getTaskCategory(task: KanbanTask): string[] {
    if (!task.labels || task.labels.length === 0) {
        return ['general'];
    }
    return task.labels;
}

/**
 * Find the best matching role for a task
 * Used for automatic task assignment suggestions
 */
export function suggestRoleForTask(task: KanbanTask): string[] {
    const suggestions: string[] = [];
    const taskLabels = (task.labels || []).map(l => l.toLowerCase());

    if (taskLabels.length === 0) {
        // No labels - suggest coordinators decide
        return ['master', 'orchestrator'];
    }

    // Check each role's categories
    for (const [role, categories] of Object.entries(ROLE_CATEGORY_MAP)) {
        if (categories.length === 0) continue; // Skip coordinators

        const matches = categories.filter(cat =>
            taskLabels.some(label => label.includes(cat) || cat.includes(label))
        );

        if (matches.length > 0) {
            suggestions.push(role);
        }
    }

    // If no specific matches, suggest builders as default implementers
    if (suggestions.length === 0) {
        suggestions.push('builder');
    }

    return suggestions;
}

/**
 * Get all tasks that are blocked and need attention
 */
export function getBlockedTasks(allTasks: KanbanTask[]): KanbanTaskSummary[] {
    return allTasks
        .filter(t => t.status === 'blocked' || (t.blockers?.some(b => !b.resolvedAt)))
        .map(toTaskSummary);
}

/**
 * Get tasks by specific role category
 */
export function getTasksByCategory(
    allTasks: KanbanTask[],
    category: string
): KanbanTaskSummary[] {
    return allTasks
        .filter(t => t.labels?.some(l => l.toLowerCase() === category.toLowerCase()))
        .map(toTaskSummary);
}

/**
 * Format a timestamp as relative time (e.g., "5m ago", "2h ago")
 */
function formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
}
