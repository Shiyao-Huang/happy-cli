/**
 * @module roleConstants
 * @description Canonical role category arrays and collaboration routing.
 *
 * ```mermaid
 * graph TD
 *   A[roleConstants] --> B[roles.config.ts]
 *   C[rolePredicates] --> A
 *   D[promptBuilder] --> A
 *   D --> C
 * ```
 *
 * ## Exports
 * - COORDINATION_ROLES, BYPASS_ROLES, IMPLEMENTATION_ROLES,
 *   REVIEW_ROLES, DEPRECATED_ROLES, NON_TASK_OWNING_ROLES,
 *   RESEARCH_ROLES, PRODUCT_ROLES, DESIGN_ROLES, DOCUMENTATION_ROLES
 * - RBAC capability constants (single source of truth for role checks):
 *   INSPECT_PRIVILEGED_ROLES, SCORING_ROLES, GENOME_EDIT_ROLES,
 *   TASK_CREATE_ROLES, TOOL_GRANT_ROLES, AGENT_REPLACE_ROLES,
 *   SUPERVISOR_OBSERVATION_ROLES
 * - ROLE_COLLABORATION_MAP, getRoleCollaborators()
 * - isTaskOwningRole() (internal helper re-exported for promptBuilder)
 */

// === Role Category Constants ===
// Canonical role-to-category mapping.
// Derived from ROLE_DEFINITIONS.yaml categories; kept here as the single
// source of truth so we never depend on runtime YAML file resolution.

// Coordination: Task management, team coordination, planning
export const COORDINATION_ROLES = [
    'master',
    'orchestrator',
    'org-manager',
    'project-manager',
    'product-owner'
];

// Implementation: Code writing, building, architecture
export const IMPLEMENTATION_ROLES = [
    'builder',
    'framer',
    'implementer',
    'architect',
    'solution-architect'
];

// Review/QA: Code review, testing
export const REVIEW_ROLES = [
    'reviewer',
    'qa-engineer',
    'qa',  // Quality Assurance (alias)
];

/**
 * @deprecated Observer role removed in v0.2.
 * Observer added zero valuable contributions and was a pure noise source.
 * Progress logging is now handled automatically by Ralph Loop via appendProgress().
 */
export const DEPRECATED_ROLES = ['observer'];

// Bypass roles: operate outside the normal task workflow.
// They observe, score, and intervene but never execute implementation tasks.
export const BYPASS_ROLES = ['supervisor', 'help-agent'];

// =============================================================================
// RBAC CAPABILITY CONSTANTS — single source of truth for role-based access checks.
// All inline role checks in supervisorTools / inspectionTools / agentTools /
// taskFilter should import from here instead of repeating string literals.
// =============================================================================

/** Roles that can inspect other agents' sessions and read all genome specs. */
export const INSPECT_PRIVILEGED_ROLES = ['supervisor', 'org-manager', 'master', 'agent-builder', 'help-agent'] as const;

/** Roles that can score agents (score_agent, score_supervisor_self, etc.). */
export const SCORING_ROLES = ['supervisor', 'help-agent', 'master', 'orchestrator', 'org-manager'] as const;

/** Roles that can edit / evolve / mutate genome specs. */
export const GENOME_EDIT_ROLES = ['supervisor', 'org-manager', 'agent-builder', 'master', 'help-agent'] as const;

/** Roles that can create team tasks on behalf of the team. */
export const TASK_CREATE_ROLES = ['master', 'orchestrator'] as const;

/** Roles that can grant or revoke temporary tool access for other sessions. */
export const TOOL_GRANT_ROLES = ['supervisor', 'master'] as const;

/** Roles that can respawn / replace agents. */
export const AGENT_REPLACE_ROLES = ['supervisor', 'master', 'help-agent'] as const;

/** Roles that can read team logs, CC logs, and runtime logs (observation-only, no mutation). */
export const SUPERVISOR_OBSERVATION_ROLES = ['supervisor', 'help-agent', 'org-manager', 'master'] as const;

/** Roles that can inspect genome specs for QA/review purposes (read-only, limited to non-private namespaces). */
export const QA_INSPECTOR_ROLES = ['qa-engineer', 'qa', 'engineering-code-reviewer'] as const;

export const NON_TASK_OWNING_ROLES = [
    'org-manager',
    ...DEPRECATED_ROLES,
    ...BYPASS_ROLES,
];

export function isTaskOwningRole(roleKey: string): boolean {
    return !NON_TASK_OWNING_ROLES.includes(roleKey);
}

// Research: Information gathering, analysis
export const RESEARCH_ROLES = [
    'researcher',
    'scout',
    'ux-researcher',
    'business-analyst'
];

// Product: Product vision, requirements, prioritization
export const PRODUCT_ROLES = [
    'product-owner',
    'product-designer',
    'spec-writer'
];

// Design: UX/UI design, user experience
export const DESIGN_ROLES = [
    'ux-designer',
    'product-designer'
];

// Documentation: Writing, documentation maintenance
export const DOCUMENTATION_ROLES = [
    'scribe',
    'technical-writer',
    'spec-writer'
];

// =============================================================================
// ROLE COLLABORATION MAP - Simplified Workflow-Based Design
// =============================================================================
//
// Design Principles:
// 1. Master/Orchestrator is the ONLY entry point for User messages
// 2. Each role has a clear UPSTREAM (receives tasks from) and DOWNSTREAM (hands off to)
// 3. Minimize cross-talk to avoid message flooding
// 4. @mention always works regardless of this map
//
// Workflow:
//   User → Master → [Framer → Builder → Reviewer → QA] → Master → User
//                      ↑
//                   Architect (technical guidance)
//
// =============================================================================

export const ROLE_COLLABORATION_MAP: Record<string, string[]> = {
    // ===========================================
    // COORDINATION (听 user + 接收所有汇报)
    // ===========================================
    'master': ['user'],        // Master ONLY listens to user, receives reports via task-update
    'orchestrator': ['user'],  // Same as master
    'org-manager': [],         // Seed agent: listens to NO ONE, it is the first agent spawned
    'project-manager': ['master', 'orchestrator'],
    'product-owner': ['master', 'orchestrator'],

    // ===========================================
    // IMPLEMENTATION WORKFLOW (单向工作流)
    // ===========================================
    // Framer: 接收 Master 任务，输出设计给 Builder
    'framer': ['master', 'orchestrator', 'architect'],

    // Builder/Implementer: 接收 Framer 设计 或 Master 直接任务，输出代码给 Reviewer
    'builder': ['master', 'orchestrator', 'framer', 'architect'],
    'implementer': ['master', 'orchestrator', 'framer', 'architect'],

    // Architect: 技术顾问，听 Master 和关键实现者
    'architect': ['master', 'orchestrator', 'framer'],
    'solution-architect': ['master', 'orchestrator', 'architect'],

    // ===========================================
    // REVIEW/QA WORKFLOW (接收实现者的输出)
    // ===========================================
    // Reviewer: 接收 Builder 的代码审查请求
    'reviewer': ['master', 'orchestrator', 'builder', 'implementer'],

    // QA: 接收 Reviewer 通过后的测试请求，或直接从 Builder
    'qa-engineer': ['master', 'orchestrator', 'builder', 'reviewer'],
    'qa': ['master', 'orchestrator', 'builder', 'reviewer'],

    // Observer: REMOVED in v0.2 (zero valuable contributions, pure noise source)
    // Progress logging is now handled automatically by Ralph Loop.
    // Kept in map for backwards compatibility with existing team configs.
    'observer': [],  // Empty array = listens to nobody = effectively disabled

    // ===========================================
    // SUPPORT ROLES (按需响应)
    // ===========================================
    // Research: 支持角色，只听协调者的请求
    'researcher': ['master', 'orchestrator'],
    'scout': ['master', 'orchestrator'],
    'ux-researcher': ['master', 'orchestrator', 'product-owner'],
    'business-analyst': ['master', 'orchestrator', 'product-owner'],

    // Product: 听协调者和产品相关角色
    'product-designer': ['master', 'orchestrator', 'product-owner'],
    'spec-writer': ['master', 'orchestrator', 'product-owner'],

    // Design: 听协调者和产品设计
    'ux-designer': ['master', 'orchestrator', 'product-designer'],

    // Documentation: 只听协调者
    'scribe': ['master', 'orchestrator'],
    'technical-writer': ['master', 'orchestrator'],

    // ===========================================
    // BYPASS ROLES (observe + intervene, no tasks)
    // ===========================================
    // Supervisor: reads logs and scores agents, listens to nobody (self-triggered)
    'supervisor': [],

    // Help Agent: responds to help requests, listens to nobody (event-triggered)
    'help-agent': [],

    // ===========================================
    // SPECIAL ROLES (genome authoring)
    // ===========================================
    // Agent Builder: genome architect, listens to user + coordinators + org-manager
    'agent-builder': ['user', 'master', 'orchestrator', 'org-manager'],
};

/**
 * Get the roles that a given role should listen to for collaboration
 * @param myRole The role to get collaborators for
 * @returns Array of role names that this role should listen to
 */
export function getRoleCollaborators(myRole: string, genomeListen?: string[] | '*'): string[] {
    // Genome spec takes priority over hardcode map
    if (genomeListen !== undefined) {
        if (genomeListen === '*') return ['*'];
        return genomeListen;
    }
    const collaborators = ROLE_COLLABORATION_MAP[myRole];
    if (collaborators) {
        return collaborators;
    }
    // Default: listen to coordination roles only
    return ['master', 'orchestrator', 'user'];
}
