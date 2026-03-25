import type { GenomeSpec } from '@/api/types/genome';

export const CORE_TEAM_TOOLS = [
    'create_task',
    'update_task',
    'list_tasks',
    'start_task',
    'complete_task',
    'report_blocker',
    'resolve_blocker',
    'add_task_comment',
    'create_subtask',
    'list_subtasks',
    'delete_task',
    'send_team_message',
    'get_team_info',
    'get_context_status',
    'change_title',
    'request_help',
];

export const SPAWN_CAPABLE_TEAM_TOOLS = [
    'list_available_agents',
    'create_agent',
    'list_team_agents',
    'get_team_config',
];

const TEAM_PROTOCOL_RULES = [
    'Use the Kanban board as the source of truth: check list_tasks for assigned work, and use start_task / complete_task to keep lifecycle accurate',
    'Follow your genome\\\'s assignment policy before claiming unassigned work. If you require explicit assignment, wait for assignment instead of self-assigning',
    'Coordinate via send_team_message; use request_help or @help when blocked',
];

const TEAM_RESPONSIBILITY_RULE = 'Track assigned work on the Kanban board and keep task status current.';
const TEAM_CAPABILITIES = ['kanban-task-lifecycle', 'team-collaboration'];

function uniqueStrings(values: unknown[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }

    return result;
}

type SpawnCapabilitySpec = Pick<GenomeSpec, 'authorities' | 'behavior'> | null | undefined;

function genomeHasSpawnCapability(spec?: SpawnCapabilitySpec): boolean {
    return spec?.behavior?.canSpawnAgents === true
        || (Array.isArray(spec?.authorities) && spec.authorities.includes('agent.spawn'));
}

export function getInjectedAllowedToolsForGenome(
    spec?: SpawnCapabilitySpec,
    options?: { spawnCapable?: boolean },
): string[] {
    const spawnCapable = options?.spawnCapable ?? genomeHasSpawnCapability(spec);
    return uniqueStrings([
        ...CORE_TEAM_TOOLS,
        ...(spawnCapable ? SPAWN_CAPABLE_TEAM_TOOLS : []),
    ]);
}

function hasTaskLifecycleText(values: string[]): boolean {
    return values.some((value) => /kanban|task|list_tasks|start_task|complete_task|board/i.test(value));
}

export function normalizeGenomeSpecForPublication(input: {
    specJson: string;
    namespace?: string;
    parentId?: string;
    mutationNote?: string;
    origin?: 'original' | 'forked' | 'mutated';
}): { spec: GenomeSpec & Record<string, unknown>; specJson: string; warnings: string[] } {
    const specObj = JSON.parse(input.specJson) as GenomeSpec & Record<string, unknown>;
    const warnings: string[] = [];
    const isOfficial = input.namespace === '@official';

    if (!isOfficial) {
        delete specObj.hooks;

        if (specObj.permissionMode && !['default', 'acceptEdits'].includes(specObj.permissionMode)) {
            specObj.permissionMode = 'default';
        } else {
            delete specObj.permissionMode;
        }

        if (specObj.executionPlane === 'bypass') {
            specObj.executionPlane = 'mainline';
        } else {
            delete specObj.executionPlane;
        }

        if (specObj.accessLevel === 'full-access') {
            delete specObj.accessLevel;
        }
    }

    if (Array.isArray(specObj.allowedTools)) {
        specObj.allowedTools = uniqueStrings([
            ...getInjectedAllowedToolsForGenome(specObj),
            ...specObj.allowedTools,
        ]);
    } else if (specObj.allowedTools !== undefined) {
        delete specObj.allowedTools;
        warnings.push(
            'allowedTools was not a string[] and has been ignored. Specify an explicit allowlist if you want portable whitelist-based tool control.',
        );
    } else {
        warnings.push(
            'allowedTools omitted: core team tools were not injected because allowedTools acts as a restrictive whitelist. Consider explicitly listing required tools for portable marketplace genomes.',
        );
    }

    const existingProtocol = Array.isArray(specObj.protocol)
        ? uniqueStrings(specObj.protocol)
        : [];
    if (!hasTaskLifecycleText(existingProtocol)) {
        specObj.protocol = uniqueStrings([...existingProtocol, ...TEAM_PROTOCOL_RULES]);
    } else {
        specObj.protocol = existingProtocol;
    }

    const responsibilities = Array.isArray(specObj.responsibilities)
        ? uniqueStrings(specObj.responsibilities)
        : [];
    if (!hasTaskLifecycleText(responsibilities)) {
        specObj.responsibilities = uniqueStrings([...responsibilities, TEAM_RESPONSIBILITY_RULE]);
    } else {
        specObj.responsibilities = responsibilities;
    }

    const capabilities = Array.isArray(specObj.capabilities)
        ? uniqueStrings(specObj.capabilities)
        : [];
    specObj.capabilities = uniqueStrings([...capabilities, ...TEAM_CAPABILITIES]);

    if (input.parentId !== undefined || input.mutationNote !== undefined || input.origin !== undefined) {
        const existingProvenance = specObj.provenance && typeof specObj.provenance === 'object'
            ? specObj.provenance as (NonNullable<GenomeSpec['provenance']> & Record<string, unknown>)
            : {};
        const nextProvenance: NonNullable<GenomeSpec['provenance']> & Record<string, unknown> = {
            ...existingProvenance,
        };
        if (input.origin) nextProvenance.origin = input.origin;
        if (input.parentId) nextProvenance.parentId = input.parentId;
        if (input.mutationNote !== undefined) {
            if (input.mutationNote) {
                nextProvenance.mutationNote = input.mutationNote;
            } else {
                delete nextProvenance.mutationNote;
            }
        }
        specObj.provenance = nextProvenance;
    }

    return {
        spec: specObj,
        specJson: JSON.stringify(specObj),
        warnings,
    };
}
