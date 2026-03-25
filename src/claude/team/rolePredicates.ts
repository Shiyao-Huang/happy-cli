/**
 * @module rolePredicates
 * @description Role classification predicates, permission helpers, and handshake utilities.
 *
 * ```mermaid
 * graph TD
 *   C[rolePredicates] --> A[roleConstants]
 *   C --> B[roles.config.ts]
 *   D[promptBuilder] --> C
 * ```
 *
 * ## Exports
 * - isCoordinatorRole, isBypassRole, isBootstrapRole, canSpawnAgents,
 *   canCreateTeamTasks, canManageExistingTasks, hasTeamAuthority
 * - shouldListenTo, getRolePermissions, RolePermissions
 * - buildAgentHandshakeContent, AgentHandshakeContentOptions
 * - isDeprecatedRole, validateTeamRoles
 */

import { logger } from '@/ui/logger';
import { DEFAULT_ROLES } from './roles.config';
import {
    COORDINATION_ROLES,
    BYPASS_ROLES,
    DEPRECATED_ROLES,
    getRoleCollaborators,
} from './roleConstants';

function isLegacyOfficialMasterSpawnBugGenome(
    role: string | undefined,
    genome?: {
        namespace?: string;
        name?: string;
        baseRoleId?: string;
        version?: number;
        behavior?: { canSpawnAgents?: boolean };
    } | null,
): boolean {
    if (role !== 'master' && role !== 'orchestrator') {
        return false;
    }
    if (genome?.behavior?.canSpawnAgents !== false) {
        return false;
    }

    const namespace = genome?.namespace;
    const canonicalName = genome?.name ?? genome?.baseRoleId;
    const version = genome?.version;

    return namespace === '@official'
        && canonicalName === 'master'
        && typeof version === 'number'
        && version <= 2;
}

// ── Genome-first role classification ─────────────────────────────────────────
// GenomeSpec is the authority. These hardcoded lists are fallbacks for when
// no genome is loaded (local dev, legacy agent.json, etc.)
// When a genome is available, use executionPlane / behavior.canSpawnAgents /
// messaging.receiveUserMessages / teamRole instead of these lists.

export function isCoordinatorRole(role: string | undefined, genome?: { messaging?: { receiveUserMessages?: boolean }; teamRole?: string } | null): boolean {
    if (genome?.messaging?.receiveUserMessages) return true;
    return !!role && COORDINATION_ROLES.includes(role);
}

export function isBypassRole(role: string | undefined, genome?: { executionPlane?: string } | null): boolean {
    if (genome?.executionPlane === 'bypass') return true;
    return !!role && BYPASS_ROLES.includes(role);
}

export function isBootstrapRole(role: string | undefined, genome?: { executionPlane?: string; behavior?: { canSpawnAgents?: boolean } } | null): boolean {
    if (!role) return false;

    // Genome authority: bootstrap = can spawn + bypass, or org-manager role
    if (genome?.behavior?.canSpawnAgents && genome?.executionPlane !== 'bypass') {
        // org-manager pattern: can spawn but runs mainline, auto-retires
        if (role === 'org-manager') return true;
    }

    // Fallback: hardcoded
    if (role === 'org-manager' || isBypassRole(role, genome)) return true;
    return false;
}

export function canSpawnAgents(
    role: string | undefined,
    genome?: {
        namespace?: string;
        name?: string;
        baseRoleId?: string;
        version?: number;
        behavior?: { canSpawnAgents?: boolean };
        authorities?: string[];
    } | null,
): boolean {
    if (Array.isArray(genome?.authorities) && genome!.authorities!.includes('agent.spawn')) return true;
    // Coordinator roles (master, orchestrator) must always be able to spawn agents
    // to manage team topology — genome canSpawnAgents:false should not block them.
    // This fixes the permission chain where master could not spawn supervisor.
    if (isCoordinatorRole(role)) return true;
    if (genome?.behavior?.canSpawnAgents !== undefined) {
        if (genome.behavior.canSpawnAgents) {
            return true;
        }
        // Compatibility shim for the bad @official/master v2 seed. Older teams
        // still carry that spec, but Master is expected to remain spawn-capable.
        if (isLegacyOfficialMasterSpawnBugGenome(role, genome)) {
            return true;
        }
        return false;
    }
    // agent-builder genome defines canSpawnAgents:true; add hardcoded fallback for solo/no-genome sessions
    // (genome spec is authoritative when loaded, this fallback covers local dev and direct-chat solo sessions)
    if (role === 'agent-builder') return true;
    return isBootstrapRole(role) || isCoordinatorRole(role);
}

export function canCreateTeamTasks(role: string | undefined, genome?: { behavior?: { canSpawnAgents?: boolean }; authorities?: string[] } | null): boolean {
    if (Array.isArray(genome?.authorities) && genome!.authorities!.includes('task.create')) return true;
    // Note: canSpawnAgents governs agent-spawning, NOT task creation — these are independent capabilities.
    // A coordinator role (master, orchestrator) can always create tasks; genome can restrict via authorities[].
    return isBootstrapRole(role) || isCoordinatorRole(role);
}

export function canManageExistingTasks(role: string | undefined, genome?: { messaging?: { receiveUserMessages?: boolean }; authorities?: string[] } | null): boolean {
    if (Array.isArray(genome?.authorities) && genome!.authorities!.some((authority: string) => ['task.assign', 'task.update.any', 'task.approve', 'task.create'].includes(authority))) {
        return true;
    }
    if (genome?.messaging?.receiveUserMessages) return true;
    return isCoordinatorRole(role);
}

export function hasTeamAuthority(
    authorities: string[] | undefined | null,
    authority: string
): boolean {
    return Array.isArray(authorities) && authorities.includes(authority);
}

export interface AgentHandshakeContentOptions {
    role: string;
    roleTitle?: string;
    isCoordinator?: boolean;
    isBootstrap?: boolean;
    roleDescription?: string;
    responsibilities?: string[];
    capabilities?: string[];
    scopeSummary?: string;
}

function normalizeHandshakeBullets(items: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        normalized.push(trimmed);
    }

    return normalized;
}

export function buildAgentHandshakeContent(options: AgentHandshakeContentOptions): string {
    if (options.isBootstrap) {
        return '';
    }

    const roleDef = DEFAULT_ROLES[options.role];
    const roleTitle = options.roleTitle || roleDef?.name || options.role;
    const isCoordinator = options.isCoordinator ?? COORDINATION_ROLES.includes(options.role);
    const capabilities = normalizeHandshakeBullets([
        ...(options.responsibilities || []),
        ...(options.capabilities || []),
    ]);
    const capabilityText = capabilities.length > 0
        ? capabilities.map((item, index) => `${index + 1}. ${item}`).join('\n')
        : '1. Ready to assist the team';
    const roleSummary = options.roleDescription?.trim() || roleDef?.name || roleTitle;
    const runtimeScopeSummary = process.env.AHA_AGENT_SCOPE_SUMMARY?.trim();
    const resolvedScopeSummary = runtimeScopeSummary || options.scopeSummary?.trim();
    const scopeLine = resolvedScopeSummary
        ? `\n**Boundary:** ${resolvedScopeSummary}`
        : '';
    const helpLaneLine = '**Help Lane:** If blocked, call `request_help` with evidence. `@help` in team chat triggers the same escalation path.';

    if (isCoordinator) {
        return `🎯 **${roleTitle}** reporting for duty!

**My Role:** ${roleSummary}${scopeLine}

**Readiness Check:** I have read SYSTEM.md and AGENTS.md, I know the help lane (\`request_help\` / \`@help\`), and I will coordinate within my assigned role boundary.

**Immediate Actions:**
1. Review project requirements and live team state
2. Break down work into actionable tasks on the kanban board
3. Assign tasks with clear ownership and escalation paths

📢 **Team Members:** Before starting, confirm your scope and use the help lane if blocked.
${helpLaneLine}`;
    }

    return `✅ **${roleTitle}** online and ready!

**My Capabilities:**
${capabilityText}${scopeLine}

**Readiness Check:** I have read SYSTEM.md and AGENTS.md. I know to use \`request_help\` or \`@help\` when blocked, and I will stay within my assigned scope.

**Status:** Awaiting task assignment from @master or @orchestrator.
${helpLaneLine}`;
}

/**
 * Check if a role is deprecated and should not be used for new teams.
 */
export function isDeprecatedRole(role: string): boolean {
    return DEPRECATED_ROLES.includes(role);
}

/**
 * Validate team roles and return warnings for deprecated roles.
 */
export function validateTeamRoles(roles: string[]): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];
    for (const role of roles) {
        if (isDeprecatedRole(role)) {
            warnings.push(`Role '${role}' is deprecated and will be ignored. Progress logging is handled automatically.`);
        }
    }
    return { valid: true, warnings };
}

/**
 * Check if a role should respond to a message from another role
 * @param myRole My role
 * @param fromRole The role of the message sender
 * @returns true if I should consider responding
 */
export function shouldListenTo(myRole: string, fromRole: string | undefined, genomeListen?: string[] | '*'): boolean {
    // Deprecated roles never listen
    if (isDeprecatedRole(myRole)) {
        return false;
    }

    if (!fromRole || fromRole === 'user') {
        // User messages: check genome spec first, then coordinator check, then collaboration map
        if (genomeListen !== undefined) {
            const collaborators = getRoleCollaborators(myRole, genomeListen);
            return collaborators.includes('*') || collaborators.includes('user');
        }
        if (isCoordinatorRole(myRole)) {
            return true;
        }
        const collaborators = getRoleCollaborators(myRole);
        return collaborators.includes('user');
    }

    const collaborators = getRoleCollaborators(myRole, genomeListen);
    return collaborators.includes('*') || collaborators.includes(fromRole);
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

    //2. Determine Available Tools (Capabilities) — genome-first, no hardcoded fallback.
    // Tool visibility should not silently inherit old role-based spawn restrictions
    // when no genome is loaded. Runtime tool handlers remain the hard authority.
    const roleDisallowedTools: string[] = [];

    return {
        permissionMode,
        disallowedTools: roleDisallowedTools
    };
}
