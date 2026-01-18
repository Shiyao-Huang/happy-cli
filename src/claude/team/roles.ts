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
