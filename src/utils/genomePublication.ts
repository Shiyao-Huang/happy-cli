import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAhaHomeDir } from '@/configurationResolver';
import type { AgentImage } from '@/api/types/genome';
import { resolveDeclaredSkillSource } from '@/skills/skillResolver';

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
    'get_self_view',
    'get_effective_permissions',
    'list_visible_tools',
    'explain_tool_access',
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
    'Follow your AgentImage\\\'s assignment policy before claiming unassigned work. If you require explicit assignment, wait for assignment instead of self-assigning',
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

function projectCanonicalAgentJsonToAgentImage(value: JsonRecord): AgentImage & JsonRecord {
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

    const projected: AgentImage & JsonRecord = {
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
        permissionMode: (asString(value.permissionMode) ?? asString(permissions?.permissionMode)) as AgentImage['permissionMode'],
        accessLevel: (asString(value.accessLevel) ?? asString(permissions?.accessLevel)) as AgentImage['accessLevel'],
        executionPlane: (asString(value.executionPlane) ?? asString(permissions?.executionPlane)) as AgentImage['executionPlane'],
        maxTurns: asInteger(value.maxTurns) ?? asInteger(permissions?.maxTurns),
        teamRole: asString(value.teamRole) ?? asString(context?.teamRole),
        capabilities: asStringArray(value.capabilities) ?? asStringArray(context?.capabilities),
        authorities: (asStringArray(value.authorities) ?? asStringArray(context?.authorities)) as AgentImage['authorities'],
        messaging: isRecord(value.messaging) ? value.messaging as AgentImage['messaging'] : (messaging as AgentImage['messaging'] | undefined),
        behavior: isRecord(value.behavior) ? value.behavior as AgentImage['behavior'] : (behavior as AgentImage['behavior'] | undefined),
        runtimeType: (asString(value.runtimeType) ?? asString(value.runtime)) as AgentImage['runtimeType'],
        provenance: isRecord(value.provenance)
            ? value.provenance as AgentImage['provenance']
            : {
                parentId: asString(evolution?.parentRef),
                mutationNote: asString(evolution?.mutationNote),
                origin: asString(evolution?.origin) as NonNullable<AgentImage['provenance']>['origin'],
            },
        evalCriteria: asStringArray(value.evalCriteria) ?? asStringArray(evaluation?.criteria),
        lifecycle: (asString(value.lifecycle) ?? asString(market?.lifecycle)) as AgentImage['lifecycle'],
        skills: asStringArray(value.skills) ?? asStringArray(tools?.skills),
        files: isRecord(value.files) ? value.files as Record<string, string> : undefined,
        workspace: isRecord(value.workspace) ? value.workspace as AgentImage['workspace'] : undefined,
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

type SpawnCapabilitySpec = Pick<AgentImage, 'authorities' | 'behavior'> | null | undefined;

function agentImageHasSpawnCapability(spec?: SpawnCapabilitySpec): boolean {
    return spec?.behavior?.canSpawnAgents === true
        || (Array.isArray(spec?.authorities) && spec.authorities.includes('agent.spawn'));
}

export function getInjectedAllowedToolsForAgentImage(
    spec?: SpawnCapabilitySpec,
    options?: { spawnCapable?: boolean },
): string[] {
    const spawnCapable = options?.spawnCapable ?? agentImageHasSpawnCapability(spec);
    return uniqueStrings([
        ...CORE_TEAM_TOOLS,
        ...(spawnCapable ? SPAWN_CAPABLE_TEAM_TOOLS : []),
    ]);
}

function hasTaskLifecycleText(values: string[]): boolean {
    return values.some((value) => /kanban|task|list_tasks|start_task|complete_task|board/i.test(value));
}

export function normalizeAgentImageForPublication(input: {
    specJson: string;
    namespace?: string;
    parentId?: string;
    mutationNote?: string;
    origin?: 'original' | 'forked' | 'mutated';
    /**
     * Root of the local runtime-lib directory used to auto-inline skill content.
     * Defaults to `{AHA_HOME_DIR}/runtime-lib`.
     * Pass `null` to disable skill auto-inlining entirely.
     */
    runtimeLibRoot?: string | null;
}): { spec: AgentImage & Record<string, unknown>; specJson: string; warnings: string[] } {
    const parsed = JSON.parse(input.specJson) as AgentImage & JsonRecord;
    const specObj = isRecord(parsed) && isCanonicalAgentJson(parsed)
        ? projectCanonicalAgentJsonToAgentImage(parsed)
        : parsed;
    const warnings: string[] = [];
    const isOfficial = input.namespace === '@official';

    if (isRecord(parsed) && isCanonicalAgentJson(parsed)) {
        warnings.push('Canonical agent.json authoring detected: publishing a flattened AgentImage compatibility projection for legacy readers.');
    }

    if (Array.isArray((specObj as JsonRecord).tools)) {
        const legacyTools = uniqueStrings((specObj as JsonRecord).tools as unknown[]);
        specObj.allowedTools = uniqueStrings([
            ...(Array.isArray(specObj.allowedTools) ? specObj.allowedTools : []),
            ...legacyTools,
        ]);
        delete (specObj as JsonRecord).tools;
        warnings.push('Legacy tools[] migrated to allowedTools for compatibility.');
    }

    if ('seedContext' in (specObj as JsonRecord)) {
        delete (specObj as JsonRecord).seedContext;
        warnings.push('Legacy seedContext is deprecated and has been removed from the published compatibility projection.');
    }

    if (!isOfficial) {
        // hooks are a kernel field (unified-schema-design.md AgentKernel) and must travel with the agent image.
        // Security note: hooks contain shell commands; the runtime materializer is responsible for
        // validating hooks before execution. Org-managers are responsible for choosing trusted agent images.
        if (specObj.hooks) {
            warnings.push(
                'AgentImage includes hooks (shell commands). The runtime will execute these when this image is spawned. ' +
                'Only spawn from agent images you trust.',
            );
        }

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
            ...getInjectedAllowedToolsForAgentImage(specObj),
            ...specObj.allowedTools,
        ]);
    } else if (specObj.allowedTools !== undefined) {
        delete specObj.allowedTools;
        warnings.push(
            'allowedTools was not a string[] and has been ignored. Specify an explicit allowlist if you want portable whitelist-based tool control.',
        );
    } else {
        warnings.push(
            'allowedTools omitted: core team tools were not injected because allowedTools acts as a restrictive whitelist. Consider explicitly listing required tools for portable marketplace agent images.',
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
            ? specObj.provenance as (NonNullable<AgentImage['provenance']> & Record<string, unknown>)
            : {};
        const nextProvenance: NonNullable<AgentImage['provenance']> & Record<string, unknown> = {
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

    // Auto-inline skill content from runtime-lib so the agent image is self-contained
    // when published to the marketplace (no runtime-lib dependency on target machine).
    if (input.runtimeLibRoot !== null && Array.isArray(specObj.skills) && specObj.skills.length > 0) {
        const libRoot = input.runtimeLibRoot ?? join(resolveAhaHomeDir(), 'runtime-lib');
        const existingFiles: Record<string, string> = isRecord(specObj.files) ? specObj.files as Record<string, string> : {};
        const inlinedFiles: Record<string, string> = { ...existingFiles };

        for (const skill of specObj.skills) {
            if (typeof skill !== 'string') continue;
            const fileKey = `.claude/commands/${skill}/SKILL.md`;
            if (inlinedFiles[fileKey] !== undefined) {
                // User provided explicit inline content — never overwrite.
                continue;
            }
            const resolved = resolveDeclaredSkillSource({
                skillName: skill,
                runtimeLibRoot: libRoot,
            });
            if (resolved) {
                inlinedFiles[fileKey] = readFileSync(join(resolved.path, 'SKILL.md'), 'utf-8');
            } else {
                warnings.push(
                    `Skill "${skill}" has no inline content and was not found in runtime-lib or user skill roots. ` +
                    `Add it to spec.files['.claude/commands/${skill}/SKILL.md'] for cross-machine portability.`,
                );
            }
        }

        if (Object.keys(inlinedFiles).length > 0) {
            specObj.files = inlinedFiles;
        }
    }

    return {
        spec: specObj,
        specJson: JSON.stringify(specObj),
        warnings,
    };
}
