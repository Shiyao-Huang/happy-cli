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

// Create role definitions from TEAM_ROLE_LIBRARY
const roleDefinitions: Record<string, RoleDefinition> = TEAM_ROLE_LIBRARY.reduce((acc: Record<string, RoleDefinition>, role: SharedTeamRole) => {
    acc[role.id] = toRoleDefinition(role);
    return acc;
}, {} as Record<string, RoleDefinition>);

// Backward compatibility mappings: old role IDs -> new role IDs
const ROLE_ID_MIGRATIONS: Record<string, string> = {
    'master': 'master-coordinator',
    'framer': 'framing-engineer',
    'builder': 'builder-/-executor',
    'reviewer': 'reviewer-/-observer'
};

// Export DEFAULT_ROLES with backward compatibility
export const DEFAULT_ROLES: Record<string, RoleDefinition> = new Proxy(roleDefinitions, {
    get(target, prop: string) {
        // Check if the requested role is the old ID, migrate to new ID
        const migratedId = ROLE_ID_MIGRATIONS[prop] || prop;
        const roleDef = target[migratedId];

        if (!roleDef) {
            console.warn(`[RoleConfig] Role not found: ${prop} (migrated to: ${migratedId})`);
            return undefined;
        }

        // Log migration for debugging
        if (prop !== migratedId) {
            console.log(`[RoleConfig] Migrated old role ID '${prop}' -> '${migratedId}'`);
        }

        return roleDef;
    }
});