import { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { DEFAULT_ROLES } from './roles.config';

export interface RolePermissions {
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    disallowedTools: string[];
}

export function getRolePermissions(role: string | undefined, requestedMode: string | undefined): RolePermissions {
    // 1. Determine Permission Mode (Confirmation Strategy)
    // If user requested Yolo (bypassPermissions), we KEEP it.
    let permissionMode = (requestedMode as any) || 'default';
    if (requestedMode === 'bypassPermissions') {
        permissionMode = 'bypassPermissions';
    }

    // 2. Determine Available Tools (Capabilities) based on Role Configuration
    let roleDisallowedTools: string[] = [];

    if (role && DEFAULT_ROLES[role]) {
        const roleDef = DEFAULT_ROLES[role];
        logger.debug(`[Role Enforcement] Applying configuration for role: ${role} (${roleDef.accessLevel})`);

        if (roleDef.accessLevel === 'read-only') {
            logger.debug(`[Role Enforcement] ${role} is restricted to READ-ONLY tools.`);
            roleDisallowedTools = roleDef.disallowedTools || [];
        } else {
            logger.debug(`[Role Enforcement] ${role} has FULL WRITE access.`);
        }
    } else if (role) {
        logger.warn(`[Role Enforcement] Unknown role: ${role}. Defaulting to full access (subject to permission mode).`);
    }

    return {
        permissionMode: permissionMode,
        disallowedTools: roleDisallowedTools
    };
}

export function generateRolePrompt(metadata: Metadata): string {
    if (!metadata.teamId || !metadata.role) {
        return '';
    }

    const roleKey = metadata.role;
    const teamId = metadata.teamId;
    const roleDef = DEFAULT_ROLES[roleKey];

    if (!roleDef) {
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
    if (roleKey === 'master') {
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to see current state.\n2. If empty or new request, call 'create_task' to break down work.\n3. Then 'send_team_message' to notify team.\n`;
    } else if (['builder', 'framer'].includes(roleKey)) {
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to find tasks assigned to you (or unassigned 'todo').\n2. Call 'update_task' to set status to 'in_progress'.\n3. Perform the work (edit files).\n4. Call 'update_task' to set status to 'done'.\n`;
    } else if (roleKey === 'reviewer') {
        prompt += `To start, you SHOULD:\n1. Call 'list_tasks' to find tasks in 'review' status.\n2. Read code using 'view_file'.\n3. Send feedback via 'send_team_message'.\n`;
    }

    prompt += `\n[END TEAM CONTEXT]\n`;
    return prompt;
}
