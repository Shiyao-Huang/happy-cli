import type { Metadata } from '@/api/types';
import type { AgentImage, TeamAuthority } from '@/api/types/genome';
import {
    canCreateTeamTasks,
    canManageExistingTasks,
    canSpawnAgents,
    isBootstrapRole,
    isCoordinatorRole,
} from '@/claude/team/roles';
import { INSPECT_PRIVILEGED_ROLES, QA_INSPECTOR_ROLES } from '@/claude/team/roleConstants';

export type CapabilityId =
    | 'task.create'
    | 'task.manage'
    | 'agent.spawn'
    | 'agent.replace'
    | 'session.archive';

export interface CapabilityDecision {
    capability: CapabilityId;
    source: string;
    reason: string;
    remediation?: string;
    escalateTo?: string[];
}

export interface EffectivePermissionsReport {
    sessionId: string;
    role: string;
    teamId: string | null;
    specId: string | null;
    capabilityComputation: 'derived';
    capabilityInputs: string[];
    permissionMode: string | null;
    allowedTools: string[] | null;
    deniedTools: string[] | null;
    visibleTools: string[] | null;
    hiddenTools: string[] | null;
    warnings: string[];
    grantedCapabilities: CapabilityDecision[];
    deniedCapabilities: CapabilityDecision[];
}

export interface RuntimeVisibleTool {
    rawName: string;
    name: string;
    surface: 'mcp' | 'native';
}

export interface RuntimePermissionSnapshot {
    permissionMode: string | null;
    allowedTools: string[] | null;
    deniedTools: string[] | null;
    visibleTools: string[] | null;
    visibleEntries: RuntimeVisibleTool[];
    hiddenTools: string[] | null;
    allowlistKnown: boolean;
    denylistKnown: boolean;
    visibleInventoryKnown: boolean;
    warnings: string[];
}

export interface ToolAccessExplanation {
    tool: string;
    normalizedTool: string;
    permissionMode: string | null;
    visible: boolean | null;
    visibleMatches: string[];
    allowlisted: boolean | null;
    denied: boolean | null;
    status: 'visible' | 'hidden_by_allowlist' | 'denied' | 'not_visible' | 'unknown';
    warnings: string[];
}

export interface TeamConfigSnapshot {
    teamId: string;
    name: string;
    description: string | null;
    roles: Array<{ id: string; title: string; version: number | null }>;
    agreements: Record<string, unknown> | null;
    bootContext: Record<string, unknown> | null;
    templateVersion: number | null;
}

type AuthoritySource = 'genome' | 'member' | 'teamOverlay';

interface EffectivePermissionsInput {
    sessionId: string;
    role: string;
    teamId: string | null;
    specId: string | null;
    permissionMode: string | null;
    allowedTools: string[] | null;
    deniedTools: string[] | null;
    visibleTools?: string[] | null;
    hiddenTools?: string[] | null;
    warnings?: string[];
    genomeSpec: AgentImage | null;
    memberAuthorities?: TeamAuthority[];
    teamOverlayAuthorities?: TeamAuthority[];
}

interface GenomeSpecInspectionInput {
    callerRole?: string | null;
    callerSpecId?: string | null;
    targetSpecId: string;
    targetNamespace?: string | null;
    targetBelongsToCallerTeam?: boolean;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(trimmed);
    }

    return result;
}

function includesToolName(values: string[], target: string): boolean {
    const normalizedTarget = normalizeVisibleToolName(target).toLowerCase();
    return values.some((value) => normalizeVisibleToolName(value).toLowerCase() === normalizedTarget);
}

function hasOwn(obj: object | null | undefined, key: string): boolean {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

export function canInspectGenomeSpec(input: GenomeSpecInspectionInput): boolean {
    const callerRole = input.callerRole ?? null;
    const callerSpecId = input.callerSpecId ?? null;
    const isSelfSpec = callerSpecId != null && callerSpecId === input.targetSpecId;
    if (isSelfSpec) return true;

    const isPrivilegedInspector = !!callerRole && (INSPECT_PRIVILEGED_ROLES as readonly string[]).includes(callerRole);
    if (isPrivilegedInspector) return true;

    const isQaInspector = !!callerRole && (QA_INSPECTOR_ROLES as readonly string[]).includes(callerRole);
    if (!isQaInspector) return false;

    const targetNamespace = input.targetNamespace?.trim() || null;
    return targetNamespace === '@official' || input.targetBelongsToCallerTeam === true;
}

export function normalizeVisibleToolName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;

    const mcpMatch = trimmed.match(/^mcp__.+?__(.+)$/);
    return mcpMatch?.[1] ?? trimmed;
}

export function collectRuntimeVisibleTools(metadata?: Metadata | null): RuntimeVisibleTool[] {
    const tools = Array.isArray(metadata?.tools) ? metadata.tools : [];
    const seen = new Set<string>();
    const entries: RuntimeVisibleTool[] = [];

    for (const rawName of tools) {
        if (typeof rawName !== 'string') continue;
        const trimmed = rawName.trim();
        if (!trimmed) continue;

        const name = normalizeVisibleToolName(trimmed);
        const key = `${trimmed.toLowerCase()}\u0000${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        entries.push({
            rawName: trimmed,
            name,
            surface: trimmed.startsWith('mcp__') ? 'mcp' : 'native',
        });
    }

    return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export function buildRuntimePermissionSnapshot(metadata?: Metadata | null): RuntimePermissionSnapshot {
    const runtimePermissions = metadata?.runtimePermissions;
    const allowlistKnown = hasOwn(runtimePermissions ?? null, 'allowedTools');
    const denylistKnown = hasOwn(runtimePermissions ?? null, 'disallowedTools');
    const visibleInventoryKnown = hasOwn(metadata ?? null, 'tools') && Array.isArray(metadata?.tools);
    const visibleEntries = collectRuntimeVisibleTools(metadata);
    const visibleTools = visibleInventoryKnown
        ? uniqueStrings(visibleEntries.map((entry) => entry.name))
        : null;
    const warnings: string[] = [];

    const permissionMode = typeof runtimePermissions?.permissionMode === 'string'
        ? runtimePermissions.permissionMode
        : null;
    if (!permissionMode) {
        warnings.push('Runtime permission mode unavailable in session metadata.');
    }

    const allowedTools = Array.isArray(runtimePermissions?.allowedTools)
        ? uniqueStrings(runtimePermissions.allowedTools)
        : allowlistKnown && runtimePermissions?.allowedTools === null
            ? null
            : null;

    const deniedTools = Array.isArray(runtimePermissions?.disallowedTools)
        ? uniqueStrings(runtimePermissions.disallowedTools)
        : denylistKnown && runtimePermissions?.disallowedTools === null
            ? []
            : null;

    if (!visibleInventoryKnown) {
        warnings.push('Visible tool inventory unavailable in session metadata.');
    }
    if (!allowlistKnown) {
        warnings.push('Runtime allowlist snapshot unavailable in session metadata.');
    }
    if (!denylistKnown) {
        warnings.push('Runtime denylist snapshot unavailable in session metadata.');
    }

    const hiddenTools = !allowlistKnown
        ? null
        : allowedTools && visibleTools
            ? allowedTools.filter((tool) => !includesToolName(visibleTools, tool))
            : allowedTools && !visibleTools
                ? null
                : [];

    return {
        permissionMode,
        allowedTools,
        deniedTools,
        visibleTools,
        visibleEntries,
        hiddenTools,
        allowlistKnown,
        denylistKnown,
        visibleInventoryKnown,
        warnings,
    };
}

export function explainRuntimeToolAccess(tool: string, snapshot: RuntimePermissionSnapshot): ToolAccessExplanation {
    const normalizedTool = normalizeVisibleToolName(tool);
    const normalizedToolLower = normalizedTool.toLowerCase();
    const visibleMatches = snapshot.visibleEntries
        .filter((entry) => (
            entry.name.toLowerCase() === normalizedToolLower
            || entry.rawName.toLowerCase() === tool.toLowerCase()
        ))
        .map((entry) => entry.rawName);

    const visible = !snapshot.visibleInventoryKnown
        ? null
        : visibleMatches.length > 0;
    const allowlisted = !snapshot.allowlistKnown
        ? null
        : snapshot.allowedTools === null
            ? false
            : includesToolName(snapshot.allowedTools, normalizedTool);
    const denied = !snapshot.denylistKnown
        ? null
        : snapshot.deniedTools === null
            ? false
            : includesToolName(snapshot.deniedTools, normalizedTool);

    let status: ToolAccessExplanation['status'] = 'unknown';
    if (denied === true) {
        status = 'denied';
    } else if (visible === true) {
        status = 'visible';
    } else if (allowlisted === true && visible === false) {
        status = 'hidden_by_allowlist';
    } else if (visible === false) {
        status = 'not_visible';
    }

    return {
        tool,
        normalizedTool,
        permissionMode: snapshot.permissionMode,
        visible,
        visibleMatches,
        allowlisted,
        denied,
        status,
        warnings: [...snapshot.warnings],
    };
}

function formatAuthoritySource(authority: TeamAuthority, source: AuthoritySource): string {
    switch (source) {
        case 'genome':
            return `genome.authorities includes ${authority}`;
        case 'member':
            return `team.member.authorities includes ${authority}`;
        case 'teamOverlay':
            return `team.member.teamOverlay.authorities includes ${authority}`;
        default:
            return `authority ${authority}`;
    }
}

function findAuthoritySource(
    authority: TeamAuthority,
    genomeAuthorities: Set<TeamAuthority>,
    memberAuthorities: Set<TeamAuthority>,
    teamOverlayAuthorities: Set<TeamAuthority>,
): string | null {
    if (teamOverlayAuthorities.has(authority)) return formatAuthoritySource(authority, 'teamOverlay');
    if (memberAuthorities.has(authority)) return formatAuthoritySource(authority, 'member');
    if (genomeAuthorities.has(authority)) return formatAuthoritySource(authority, 'genome');
    return null;
}

function buildTaskCreateDecision(
    role: string,
    effectiveGenome: AgentImage | null,
    genomeAuthorities: Set<TeamAuthority>,
    memberAuthorities: Set<TeamAuthority>,
    teamOverlayAuthorities: Set<TeamAuthority>,
): { granted: boolean; decision: CapabilityDecision } {
    const authoritySource = findAuthoritySource('task.create', genomeAuthorities, memberAuthorities, teamOverlayAuthorities);
    if (authoritySource) {
        return {
            granted: true,
            decision: {
                capability: 'task.create',
                source: authoritySource,
                reason: 'Granted by explicit task.create authority.',
            },
        };
    }

    if (isBootstrapRole(role, effectiveGenome)) {
        return {
            granted: true,
            decision: {
                capability: 'task.create',
                source: `rolePredicates.isBootstrapRole(${role})=true`,
                reason: 'Granted by bootstrap-role fallback.',
            },
        };
    }

    if (isCoordinatorRole(role, effectiveGenome)) {
        return {
            granted: true,
            decision: {
                capability: 'task.create',
                source: `rolePredicates.isCoordinatorRole(${role})=true`,
                reason: 'Granted by coordinator-role fallback.',
            },
        };
    }

    return {
        granted: false,
        decision: {
            capability: 'task.create',
            source: 'missing task.create authority and no coordinator/bootstrap fallback',
            reason: `Role '${role}' is not currently computed as task-creating.`,
            remediation: "Add 'task.create' to authorities or use a coordinator/bootstrap role.",
            escalateTo: ['master', 'org-manager', 'supervisor'],
        },
    };
}

function buildTaskManageDecision(
    role: string,
    effectiveGenome: AgentImage | null,
    genomeAuthorities: Set<TeamAuthority>,
    memberAuthorities: Set<TeamAuthority>,
    teamOverlayAuthorities: Set<TeamAuthority>,
): { granted: boolean; decision: CapabilityDecision } {
    const authorityCandidates: TeamAuthority[] = ['task.update.any', 'task.assign', 'task.approve', 'task.create'];
    for (const authority of authorityCandidates) {
        const authoritySource = findAuthoritySource(authority, genomeAuthorities, memberAuthorities, teamOverlayAuthorities);
        if (authoritySource) {
            return {
                granted: true,
                decision: {
                    capability: 'task.manage',
                    source: authoritySource,
                    reason: `Granted by ${authority} authority.`,
                },
            };
        }
    }

    if (canManageExistingTasks(role, effectiveGenome)) {
        return {
            granted: true,
            decision: {
                capability: 'task.manage',
                source: `rolePredicates.canManageExistingTasks(${role})=true`,
                reason: 'Granted by role-based task management fallback.',
            },
        };
    }

    return {
        granted: false,
        decision: {
            capability: 'task.manage',
            source: 'missing task.assign/task.update.any/task.approve/task.create authority',
            reason: `Role '${role}' cannot manage tasks beyond its own scoped lifecycle.`,
            remediation: "Add 'task.assign' or 'task.update.any' to authorities, or escalate to a coordinator.",
            escalateTo: ['master', 'supervisor'],
        },
    };
}

function buildAgentSpawnDecision(
    role: string,
    effectiveGenome: AgentImage | null,
    genomeAuthorities: Set<TeamAuthority>,
    memberAuthorities: Set<TeamAuthority>,
    teamOverlayAuthorities: Set<TeamAuthority>,
): { granted: boolean; decision: CapabilityDecision } {
    const authoritySource = findAuthoritySource('agent.spawn', genomeAuthorities, memberAuthorities, teamOverlayAuthorities);
    if (authoritySource) {
        return {
            granted: true,
            decision: {
                capability: 'agent.spawn',
                source: authoritySource,
                reason: 'Granted by explicit agent.spawn authority.',
            },
        };
    }

    if (effectiveGenome?.behavior?.canSpawnAgents === true) {
        return {
            granted: true,
            decision: {
                capability: 'agent.spawn',
                source: 'genome.behavior.canSpawnAgents=true',
                reason: 'Granted by genome behavior flag.',
            },
        };
    }

    if (effectiveGenome?.behavior?.canSpawnAgents === false) {
        if (canSpawnAgents(role, effectiveGenome)) {
            return {
                granted: true,
                decision: {
                    capability: 'agent.spawn',
                    source: `rolePredicates.canSpawnAgents(${role})=true`,
                    reason: 'Granted by legacy compatibility handling in the role predicate.',
                },
            };
        }

        return {
            granted: false,
            decision: {
                capability: 'agent.spawn',
                source: 'genome.behavior.canSpawnAgents=false',
                reason: 'Denied by explicit genome behavior flag.',
                remediation: "Set behavior.canSpawnAgents=true or add 'agent.spawn' to authorities.",
                escalateTo: ['org-manager', 'supervisor'],
            },
        };
    }

    if (canSpawnAgents(role, effectiveGenome)) {
        return {
            granted: true,
            decision: {
                capability: 'agent.spawn',
                source: `rolePredicates.canSpawnAgents(${role})=true`,
                reason: 'Granted by role fallback.',
            },
        };
    }

    return {
        granted: false,
        decision: {
            capability: 'agent.spawn',
            source: 'no agent.spawn authority and no spawn-capable role fallback',
            reason: `Role '${role}' cannot spawn agents.`,
            remediation: "Add 'agent.spawn' to authorities or use an org-manager / bootstrap role.",
            escalateTo: ['org-manager', 'supervisor'],
        },
    };
}

function buildRoleGateDecision(
    capability: 'agent.replace' | 'session.archive',
    role: string,
    allowedRoles: string[],
    remediation: string,
): { granted: boolean; decision: CapabilityDecision } {
    if (allowedRoles.includes(role)) {
        return {
            granted: true,
            decision: {
                capability,
                source: `tool role gate allows ${role}`,
                reason: `Granted because role '${role}' is in the allowed ${capability} gate.`,
            },
        };
    }

    return {
        granted: false,
        decision: {
            capability,
            source: `tool role gate denies ${role}`,
            reason: `Role '${role}' is not permitted to ${capability}.`,
            remediation,
            escalateTo: allowedRoles,
        },
    };
}

export function buildEffectivePermissionsReport(input: EffectivePermissionsInput): EffectivePermissionsReport {
    const genomeAuthorities = new Set<TeamAuthority>((input.genomeSpec?.authorities ?? []) as TeamAuthority[]);
    const memberAuthorities = new Set<TeamAuthority>(input.memberAuthorities ?? []);
    const teamOverlayAuthorities = new Set<TeamAuthority>(input.teamOverlayAuthorities ?? []);

    const decisions = [
        buildTaskCreateDecision(input.role, input.genomeSpec, genomeAuthorities, memberAuthorities, teamOverlayAuthorities),
        buildTaskManageDecision(input.role, input.genomeSpec, genomeAuthorities, memberAuthorities, teamOverlayAuthorities),
        buildAgentSpawnDecision(input.role, input.genomeSpec, genomeAuthorities, memberAuthorities, teamOverlayAuthorities),
        buildRoleGateDecision(
            'agent.replace',
            input.role,
            ['supervisor', 'master', 'help-agent'],
            'Escalate to supervisor, master, or help-agent.',
        ),
        buildRoleGateDecision(
            'session.archive',
            input.role,
            ['supervisor', 'org-manager', 'help-agent'],
            'Escalate to supervisor, org-manager, or help-agent.',
        ),
    ];

    return {
        sessionId: input.sessionId,
        role: input.role,
        teamId: input.teamId,
        specId: input.specId,
        capabilityComputation: 'derived',
        capabilityInputs: [
            'genome.authorities',
            'member.authorities',
            'teamOverlay.authorities',
            'rolePredicates',
        ],
        permissionMode: input.permissionMode,
        allowedTools: input.allowedTools,
        deniedTools: input.deniedTools,
        visibleTools: input.visibleTools ?? null,
        hiddenTools: input.hiddenTools ?? null,
        warnings: input.warnings ?? [],
        grantedCapabilities: decisions.filter((entry) => entry.granted).map((entry) => entry.decision),
        deniedCapabilities: decisions.filter((entry) => !entry.granted).map((entry) => entry.decision),
    };
}

export function extractTeamConfigSnapshot(teamId: string, board: Record<string, any> | null | undefined): TeamConfigSnapshot {
    const teamNode = board?.team && typeof board.team === 'object' ? board.team : {};
    const roles = Array.isArray(board?.roles) ? board.roles : [];
    const bootContext = teamNode?.bootContext ?? board?.bootContext ?? null;
    const agreements = teamNode?.agreements ?? board?.agreements ?? null;

    return {
        teamId,
        name: String(teamNode?.name ?? board?.name ?? teamId),
        description: typeof bootContext?.teamDescription === 'string' ? bootContext.teamDescription : null,
        roles: roles.map((role) => ({
            id: String(role?.id ?? 'unknown'),
            title: String(role?.title ?? role?.id ?? 'unknown'),
            version: typeof role?.version === 'number' ? role.version : null,
        })),
        agreements: agreements && typeof agreements === 'object' ? agreements : null,
        bootContext: bootContext && typeof bootContext === 'object' ? bootContext : null,
        templateVersion: typeof board?.version === 'number' ? board.version : null,
    };
}
