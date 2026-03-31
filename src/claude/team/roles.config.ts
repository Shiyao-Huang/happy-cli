/**
 * Role type definitions and board template.
 *
 * All role behavior comes from AgentImage. No hardcoded fallback.
 * If an agent has no genome, it runs as a blank agent with no role constraints.
 */

export interface RoleDefinition {
    name: string;
    description: string;
    responsibilities: string[];
    protocol: string[];
    accessLevel: 'read-only' | 'full-access';
    disallowedTools?: string[];
}

/** Empty map — genome is the only source of truth for role behavior. */
export const DEFAULT_ROLES: Record<string, RoleDefinition> = {};

/** Minimal kanban board template for team creation */
export const DEFAULT_KANBAN_BOARD = {
    columns: [
        { id: 'todo', title: 'To Do' },
        { id: 'in-progress', title: 'In Progress' },
        { id: 'done', title: 'Done' },
    ],
    tasks: [],
    taskSettings: {
        maxDepth: 3,
        statusPropagation: { autoCompleteParent: true, blockParentOnBlocked: true, cascadeDeleteSubtasks: false },
        execution: { requirePlan: true, autoLinkSessions: true, broadcastStatus: true },
    },
    team: { members: [] },
};
