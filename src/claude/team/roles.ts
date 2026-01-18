import { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { DEFAULT_ROLES } from './roles.config';

// === Role Category Constants ===
// These cover all 23 roles defined in kanban/sources/team-config/skills/

// Coordination: Task management, team coordination, planning
export const COORDINATION_ROLES = [
    'master',
    'orchestrator',
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

// Review/QA: Code review, testing, observation
export const REVIEW_ROLES = [
    'reviewer',
    'qa-engineer',
    'qa',  // Quality Assurance (alias)
    'observer'
];

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
// ROLE COLLABORATION MAP - Bidirectional Communication Design
// =============================================================================
//
// Design Principles:
// 1. Master/Orchestrator is the central coordinator that listens to ALL roles
// 2. Roles in the same workflow can communicate BIDIRECTIONALLY for discussion
// 3. This enables adaptive coordination - roles can negotiate and clarify
// 4. @mention always works regardless of this map
//
// Communication Flow (bidirectional arrows ↔ indicate two-way discussion):
//
//   User ↔ Master ↔ [All Roles]
//          ↓
//   Framer ↔ Builder ↔ Reviewer ↔ QA
//      ↑↓       ↑↓
//   Architect ↔ Solution-Architect
//
// =============================================================================

export const ROLE_COLLABORATION_MAP: Record<string, string[]> = {
    // ===========================================
    // COORDINATION (中央协调 - 听所有角色)
    // ===========================================
    // Master: 听 user 和所有团队成员的汇报与讨论
    'master': [
        'user',
        // Implementation team
        'framer', 'builder', 'implementer', 'architect', 'solution-architect',
        // Review team
        'reviewer', 'qa-engineer', 'qa', 'observer',
        // Research team
        'researcher', 'scout', 'ux-researcher', 'business-analyst',
        // Product team
        'product-owner', 'product-designer', 'spec-writer',
        // Design team
        'ux-designer',
        // Documentation team
        'scribe', 'technical-writer'
    ],
    'orchestrator': [
        'user',
        'framer', 'builder', 'implementer', 'architect', 'solution-architect',
        'reviewer', 'qa-engineer', 'qa', 'observer',
        'researcher', 'scout', 'ux-researcher', 'business-analyst',
        'product-owner', 'product-designer', 'spec-writer',
        'ux-designer',
        'scribe', 'technical-writer'
    ],
    'project-manager': ['master', 'orchestrator', 'product-owner', 'architect', 'builder', 'reviewer'],
    'product-owner': ['master', 'orchestrator', 'project-manager', 'product-designer', 'spec-writer', 'ux-researcher', 'business-analyst'],

    // ===========================================
    // IMPLEMENTATION (双向协作 - 互相讨论)
    // ===========================================
    // Framer ↔ Builder ↔ Architect 可以互相讨论设计方案
    'framer': ['master', 'orchestrator', 'builder', 'architect', 'solution-architect', 'product-designer', 'spec-writer'],
    'builder': ['master', 'orchestrator', 'framer', 'architect', 'solution-architect', 'reviewer', 'qa', 'qa-engineer', 'implementer'],
    'implementer': ['master', 'orchestrator', 'framer', 'architect', 'solution-architect', 'reviewer', 'qa', 'qa-engineer', 'builder'],
    'architect': ['master', 'orchestrator', 'framer', 'builder', 'implementer', 'solution-architect', 'reviewer'],
    'solution-architect': ['master', 'orchestrator', 'architect', 'framer', 'builder', 'implementer'],

    // ===========================================
    // REVIEW/QA (双向协作 - 反馈与修复)
    // ===========================================
    // Reviewer ↔ Builder: 讨论代码问题和修复方案
    // QA ↔ Builder: 讨论测试结果和bug修复
    'reviewer': ['master', 'orchestrator', 'builder', 'implementer', 'architect', 'qa', 'qa-engineer'],
    'qa-engineer': ['master', 'orchestrator', 'builder', 'implementer', 'reviewer', 'qa'],
    'qa': ['master', 'orchestrator', 'builder', 'implementer', 'reviewer', 'qa-engineer'],
    'observer': ['master', 'orchestrator', 'reviewer', 'qa'],

    // ===========================================
    // RESEARCH (支持角色 - 双向反馈)
    // ===========================================
    'researcher': ['master', 'orchestrator', 'scout', 'architect', 'framer'],
    'scout': ['master', 'orchestrator', 'researcher', 'builder', 'framer'],
    'ux-researcher': ['master', 'orchestrator', 'product-owner', 'product-designer', 'ux-designer'],
    'business-analyst': ['master', 'orchestrator', 'product-owner', 'project-manager', 'spec-writer'],

    // ===========================================
    // PRODUCT (产品角色 - 双向协作)
    // ===========================================
    'product-designer': ['master', 'orchestrator', 'product-owner', 'ux-designer', 'framer', 'spec-writer'],
    'spec-writer': ['master', 'orchestrator', 'product-owner', 'product-designer', 'framer', 'business-analyst'],

    // ===========================================
    // DESIGN (设计角色 - 双向反馈)
    // ===========================================
    'ux-designer': ['master', 'orchestrator', 'product-designer', 'ux-researcher', 'framer', 'builder'],

    // ===========================================
    // DOCUMENTATION (文档角色 - 收集信息)
    // ===========================================
    'scribe': ['master', 'orchestrator', 'builder', 'reviewer', 'architect'],
    'technical-writer': ['master', 'orchestrator', 'builder', 'architect', 'spec-writer', 'scribe'],
};

/**
 * Get the roles that a given role should listen to for collaboration
 * @param myRole The role to get collaborators for
 * @returns Array of role names that this role should listen to
 */
export function getRoleCollaborators(myRole: string): string[] {
    const collaborators = ROLE_COLLABORATION_MAP[myRole];
    if (collaborators) {
        return collaborators;
    }
    // Default: listen to coordination roles only
    return ['master', 'orchestrator', 'user'];
}

/**
 * Check if a role should respond to a message from another role
 * @param myRole My role
 * @param fromRole The role of the message sender
 * @returns true if I should consider responding
 */
export function shouldListenTo(myRole: string, fromRole: string | undefined): boolean {
    if (!fromRole || fromRole === 'user') {
        // User messages: coordination roles always listen, others check their map
        if (COORDINATION_ROLES.includes(myRole)) {
            return true;
        }
        const collaborators = getRoleCollaborators(myRole);
        return collaborators.includes('user');
    }

    const collaborators = getRoleCollaborators(myRole);
    return collaborators.includes(fromRole);
}

export interface RolePermissions {
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    disallowedTools: string[];
}

export function getRolePermissions(role: string | undefined, requestedMode: string | undefined): RolePermissions {
    //1. Determine Permission Mode (Confirmation Strategy)
    // If user explicitly requested Yolo (bypassPermissions), we KEEP it.
    let permissionMode = (requestedMode as any) || 'default';
    if (requestedMode === 'bypassPermissions') {
        permissionMode = 'bypassPermissions';
    }

    //2. Determine Available Tools (Capabilities) based on Role Configuration
    let roleDisallowedTools: string[] = [];

    if (role && DEFAULT_ROLES[role]) {
        const roleDef = DEFAULT_ROLES[role];
        logger.debug(`[Role Enforcement] Applying configuration for role: ${role} (${roleDef.accessLevel})`);

        // Apply role-specific restrictions
        if (roleDef.accessLevel === 'read-only') {
            // Read-only roles get restricted tools
            const READ_ONLY_TOOLS = [
                'edit_file',
                'replace_file_content',
                'multi_replace_file_content',
                'write_to_file',
                'move_file',
                'delete_file'
            ];
            roleDisallowedTools = READ_ONLY_TOOLS;
            logger.debug(`[Role Enforcement] ${role} is restricted to READ-ONLY tools.`);
        } else if (roleDef.disallowedTools) {
            // Apply explicit disallowed tools
            roleDisallowedTools = roleDef.disallowedTools;
            logger.debug(`[Role Enforcement] ${role} has ${roleDef.disallowedTools.length} disallowed tools: ${roleDef.disallowedTools.join(', ')}`);
        }
    } else {
        // Unknown role - no restrictions
        logger.warn(`[Role Enforcement] Unknown role: ${role}. Defaulting to full access (subject to permission mode).`);
    }

    return {
        permissionMode,
        disallowedTools: roleDisallowedTools
    };
}

export function generateRolePrompt(metadata: Metadata): string {
    let teamId = metadata.teamId;
    let role = metadata.role;

    logger.debug(`[Roles] generateRolePrompt called - metadata.teamId: ${JSON.stringify(metadata.teamId)}, metadata.role: ${JSON.stringify(metadata.role)}`);
    logger.debug(`[Roles] Environment vars - HAPPY_ROOM_ID: ${process.env.HAPPY_ROOM_ID}, HAPPY_AGENT_ROLE: ${process.env.HAPPY_AGENT_ROLE}`);

    // Fallback: If metadata is missing team info (e.g. due to server enc/dec mismatch),
    // try to recover from local environment variables which should be present.
    if (!teamId && process.env.HAPPY_ROOM_ID) {
        teamId = process.env.HAPPY_ROOM_ID;
        logger.debug('[Roles] ✅ Recovered teamId from HAPPY_ROOM_ID env var');
    } else if (!teamId) {
        logger.warn('[Roles] ❌ teamId not available in metadata or env vars - cannot generate role prompt');
        return '';
    }

    if (!role && process.env.HAPPY_AGENT_ROLE) {
        role = process.env.HAPPY_AGENT_ROLE;
        logger.debug('[Roles] ✅ Recovered role from HAPPY_AGENT_ROLE env var');
    } else if (!role) {
        logger.warn('[Roles] ❌ role not available in metadata or env vars - cannot generate role prompt');
        return '';
    }

    if (!teamId || !role) {
        logger.warn('[Roles] ❌ Cannot generate role prompt - missing teamId or role');
        return '';
    }

    const roleKey = role;
    const roleDef = DEFAULT_ROLES[roleKey];

    if (!roleDef) {
        logger.warn(`[Roles] ❌ Unknown role: ${roleKey}`);
        return '';
    }

    let prompt = `\n\n[SYSTEM: TEAM CONTEXT]\nYou are part of a software development team (Team ID: ${teamId}).\nYour role is: ${roleDef.name}.\n`;

    prompt += `\nRESPONSIBILITIES:\n`;
    roleDef.responsibilities.forEach((r, i) => {
        prompt += `${i + 1}. ${r}\n`;
    });

    prompt += `\nPROTOCOL:\n`;
    roleDef.protocol.forEach((p) => {
        prompt += `- ${p}\n`;
    });

    // Add Next Step Templates
    prompt += `\n[NEXT STEP GUIDANCE]\n`;

    // Role category mapping for all 23 roles
    const coordinationRoles = [...COORDINATION_ROLES];
    const implementationRoles = [...IMPLEMENTATION_ROLES];
    const reviewRoles = [...REVIEW_ROLES];
    const researchRoles = [...RESEARCH_ROLES];
    const productRoles = [...PRODUCT_ROLES];
    const designRoles = [...DESIGN_ROLES];
    const documentationRoles = [...DOCUMENTATION_ROLES];

    if (coordinationRoles.includes(roleKey)) {
        // Coordination roles (Master, Orchestrator, PM, Product Owner)
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to see current state.\n2. If empty or new request, call 'create_task' to break down work.\n3. Then 'send_team_message' to notify team.\n`;
    } else if (implementationRoles.includes(roleKey)) {
        // Implementation roles (Builder, Framer, Architect, Implementer, Solution Architect)
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to find tasks assigned to you (or unassigned 'todo').\n2. Call 'update_task' to set status to 'in_progress'.\n3. Perform your work (edit files, run tests, etc.).\n4. Call 'update_task' to set status to 'done'.\n`;
    } else if (reviewRoles.includes(roleKey)) {
        // Review/QA roles (Reviewer, QA, Observer)
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to find tasks in 'review' status or observe project state.\n2. Read code using 'view_file'.\n3. Send feedback via 'send_team_message'.\n`;
    } else if (researchRoles.includes(roleKey)) {
        // Research roles (Researcher, Scout, UX Researcher, Business Analyst)
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to find research tasks.\n2. Use 'websearch_exa' or 'view_file' to gather information.\n3. Document findings in a markdown file.\n4. Send summary via 'send_team_message'.\n`;
    } else if (productRoles.includes(roleKey)) {
        // Product roles (Product Owner, Spec Writer)
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to review backlog and priorities.\n2. Define or refine requirements and acceptance criteria.\n3. Prioritize work based on business value.\n4. Communicate decisions via 'send_team_message'.\n`;
    } else if (designRoles.includes(roleKey)) {
        // Design roles (UX Designer, Product Designer)
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to find design-related tasks.\n2. Review existing UI patterns using 'view_file'.\n3. Create or update design specs and wireframes.\n4. Share designs for feedback via 'send_team_message'.\n`;
    } else if (documentationRoles.includes(roleKey)) {
        // Documentation roles (Scribe, Technical Writer, Spec Writer)
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to find documentation tasks.\n2. Review existing documentation using 'view_file'.\n3. Update README, API docs, or changelogs.\n4. Announce updates via 'send_team_message'.\n`;
    } else {
        // Default guidance for unknown roles
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to find relevant work.\n2. Perform your role-specific responsibilities.\n3. Document your findings and decisions.\n4. Communicate with team via 'send_team_message'.\n`;
    }

    prompt += `\n[END TEAM CONTEXT]\n`;
    return prompt;
}
