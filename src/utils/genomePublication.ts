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

type JsonRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) ? uniqueStrings(value) : undefined;
}

function asInteger(value: unknown): number | undefined {
    return Number.isInteger(value) ? value as number : undefined;
}

function isCanonicalAgentJson(value: JsonRecord): boolean {
    return value.kind === 'aha.agent.v1' && typeof value.name === 'string' && typeof value.runtime === 'string';
}

function projectCanonicalAgentJsonToGenomeSpec(value: JsonRecord): GenomeSpec & JsonRecord {
    const prompt = isRecord(value.prompt) ? value.prompt : undefined;
    const tools = isRecord(value.tools) ? value.tools : undefined;
    const permissions = isRecord(value.permissions) ? value.permissions : undefined;
    const context = isRecord(value.context) ? value.context : undefined;
    const behavior = isRecord(context?.behavior) ? context.behavior : undefined;
    const messaging = isRecord(context?.messaging) ? context.messaging : undefined;
    const routing = isRecord(value.routing) ? value.routing : undefined;
    const models = isRecord(routing?.models) ? routing.models : undefined;
    const env = isRecord(value.env) ? value.env : undefined;
    const evaluation = isRecord(value.evaluation) ? value.evaluation : undefined;
    const evolution = isRecord(value.evolution) ? value.evolution : undefined;
    const market = isRecord(value.market) ? value.market : undefined;

    const projected: GenomeSpec & JsonRecord = {
        ...value,
        displayName: asString(value.displayName) ?? asString(value.name),
        description: asString(value.description),
        baseRoleId: asString(value.baseRoleId),
        namespace: asString(value.namespace) ?? asString(market?.namespace),
        tags: asStringArray(value.tags) ?? asStringArray(market?.tags),
        category: asString(value.category) ?? asString(market?.category),
        systemPrompt: asString(value.systemPrompt) ?? asString(prompt?.system),
        systemPromptSuffix: asString(value.systemPromptSuffix) ?? asString(prompt?.suffix),
        modelId: asString(value.modelId) ?? asString(models?.default),
        allowedTools: asStringArray(value.allowedTools) ?? asStringArray(tools?.allowed),
        disallowedTools: asStringArray(value.disallowedTools) ?? asStringArray(tools?.disallowed),
        mcpServers: asStringArray(value.mcpServers) ?? asStringArray(tools?.mcpServers),
        permissionMode: (asString(value.permissionMode) ?? asString(permissions?.permissionMode)) as GenomeSpec['permissionMode'],
        accessLevel: (asString(value.accessLevel) ?? asString(permissions?.accessLevel)) as GenomeSpec['accessLevel'],
        executionPlane: (asString(value.executionPlane) ?? asString(permissions?.executionPlane)) as GenomeSpec['executionPlane'],
        maxTurns: asInteger(value.maxTurns) ?? asInteger(permissions?.maxTurns),
        teamRole: asString(value.teamRole) ?? asString(context?.teamRole),
        capabilities: asStringArray(value.capabilities) ?? asStringArray(context?.capabilities),
        authorities: (asStringArray(value.authorities) ?? asStringArray(context?.authorities)) as GenomeSpec['authorities'],
        messaging: isRecord(value.messaging) ? value.messaging as GenomeSpec['messaging'] : (messaging as GenomeSpec['messaging'] | undefined),
        behavior: isRecord(value.behavior) ? value.behavior as GenomeSpec['behavior'] : (behavior as GenomeSpec['behavior'] | undefined),
        runtimeType: (asString(value.runtimeType) ?? asString(value.runtime)) as GenomeSpec['runtimeType'],
        provenance: isRecord(value.provenance)
            ? value.provenance as GenomeSpec['provenance']
            : {
                parentId: asString(evolution?.parentRef),
                mutationNote: asString(evolution?.mutationNote),
                origin: asString(evolution?.origin) as NonNullable<GenomeSpec['provenance']>['origin'],
            },
        evalCriteria: asStringArray(value.evalCriteria) ?? asStringArray(evaluation?.criteria),
        lifecycle: (asString(value.lifecycle) ?? asString(market?.lifecycle)) as GenomeSpec['lifecycle'],
        skills: asStringArray(value.skills) ?? asStringArray(tools?.skills),
    };

    if (env) {
        projected.env = 'requiredEnv' in env || 'optionalEnv' in env
            ? env
            : {
                requiredEnv: asStringArray(env.required),
                optionalEnv: asStringArray(env.optional),
            };
    }

    if (!projected.provenance || (!projected.provenance.parentId && !projected.provenance.mutationNote && !projected.provenance.origin)) {
        delete projected.provenance;
    }

    return projected;
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
    const parsed = JSON.parse(input.specJson) as GenomeSpec & JsonRecord;
    const specObj = isRecord(parsed) && isCanonicalAgentJson(parsed)
        ? projectCanonicalAgentJsonToGenomeSpec(parsed)
        : parsed;
    const warnings: string[] = [];
    const isOfficial = input.namespace === '@official';

    if (isRecord(parsed) && isCanonicalAgentJson(parsed)) {
        warnings.push('Canonical agent.json authoring detected: publishing a flattened GenomeSpec compatibility projection for legacy readers.');
    }

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
