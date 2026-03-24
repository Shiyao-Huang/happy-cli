import type { GenomeSpec, TeamAuthority } from '@/api/types/genome';
import {
    canCreateTeamTasks,
    canManageExistingTasks,
    canSpawnAgents,
    isBootstrapRole,
    isCoordinatorRole,
} from '@/claude/team/roles';

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
    permissionMode: string;
    allowedTools: string[];
    deniedTools: string[];
    grantedCapabilities: CapabilityDecision[];
    deniedCapabilities: CapabilityDecision[];
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
    permissionMode: string;
    allowedTools: string[];
    deniedTools: string[];
    genomeSpec: GenomeSpec | null;
    memberAuthorities?: TeamAuthority[];
    teamOverlayAuthorities?: TeamAuthority[];
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
    effectiveGenome: GenomeSpec | null,
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
    effectiveGenome: GenomeSpec | null,
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
    effectiveGenome: GenomeSpec | null,
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
        permissionMode: input.permissionMode,
        allowedTools: input.allowedTools,
        deniedTools: input.deniedTools,
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
