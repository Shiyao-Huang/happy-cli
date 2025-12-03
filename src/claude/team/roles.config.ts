import { TEAM_ROLE_LIBRARY } from '@happy/shared-team-config';
import type { SharedTeamRole } from '@happy/shared-team-config';

export interface RoleDefinition {
    name: string;
    description: string;
    responsibilities: string[];
    protocol: string[];
    accessLevel: 'read-only' | 'full-access';
    disallowedTools?: string[];
}

const toRoleDefinition = (role: SharedTeamRole): RoleDefinition => {
    const accessLevel = role.policy?.accessLevel
        || (role.policy?.permissionMode === 'read-only' ? 'read-only' : 'full-access');

    return {
        name: (role.title || role.id).toUpperCase(),
        description: role.summary,
        responsibilities: role.responsibilities,
        protocol: role.protocol,
        accessLevel,
        disallowedTools: role.policy?.disallowedTools
    };
};

export const DEFAULT_ROLES: Record<string, RoleDefinition> = TEAM_ROLE_LIBRARY.reduce((acc: Record<string, RoleDefinition>, role: SharedTeamRole) => {
    acc[role.id] = toRoleDefinition(role);
    return acc;
}, {} as Record<string, RoleDefinition>);
