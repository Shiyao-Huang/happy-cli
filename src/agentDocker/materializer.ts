import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { basename, join } from 'path';

import { configuration } from '@/configuration';
import type { GenomeSpec } from '@/api/types/genome';
import { buildHooksSettingsContent } from '@/claude/utils/hooksSettings';

export type WorkspaceMode = 'shared' | 'isolated';
export type AgentRuntime = 'claude' | 'codex' | 'open-code';
export type RuntimeLibResourceType = 'skills' | 'mcp' | 'prompts' | 'hooks' | 'tools';
export type MaterializationMode = 'link' | 'copy';

export interface AgentHookCommand {
    matcher?: string;
    command: string;
    description?: string;
}

export interface AgentDockerConfig {
    kind: 'aha.agent.v1';
    name: string;
    runtime: AgentRuntime;
    build?: {
        materializationPolicy?: {
            defaultMode?: MaterializationMode;
            resources?: Partial<Record<RuntimeLibResourceType, MaterializationMode>>;
            skills?: Record<string, MaterializationMode>;
        };
    };
    tools?: {
        mcpServers?: string[];
        skills?: string[];
    };
    hooks?: {
        preToolUse?: AgentHookCommand[];
        postToolUse?: AgentHookCommand[];
        stop?: AgentHookCommand[];
    };
    env?: {
        required?: string[];
        optional?: string[];
    };
    workspace?: {
        defaultMode?: WorkspaceMode;
        allowedModes?: WorkspaceMode[];
    };
}

export interface MaterializeAgentWorkspaceInput {
    agentId: string;
    repoRoot: string;
    runtime: AgentRuntime;
    config: AgentDockerConfig;
    genome?: {
        spec: GenomeSpec;
        specId?: string;
    };
    workspaceMode?: WorkspaceMode;
    runtimeLibRoot?: string;
    repoConfigRoot?: string;
    launchOverrides?: {
        env?: Record<string, string>;
        allowedSkills?: string[];
    };
}

export interface MaterializeAction {
    kind:
        | 'ensure-dir'
        | 'write-settings'
        | 'link-skill'
        | 'write-env'
        | 'write-mcp-config'
        | 'attach-repo'
        | 'create-worktree';
    target: string;
    source?: string;
    reason: string;
}

export interface MaterializeAgentWorkspaceResult {
    agentId: string;
    workspaceMode: WorkspaceMode;
    workspaceRoot: string;
    effectiveCwd: string;
    projectViewPath: string;
    genomeDir: string;
    genomeSpecPath: string;
    genomeLineagePath: string;
    genomeEvalCriteriaPath: string;
    runtimeLibRoot: string;
    repoConfigRoot: string;
    commandsDir: string;
    settingsPath: string;
    envFilePath: string;
    mcpConfigPath: string;
    logsDir: string;
    cacheDir: string;
    tmpDir: string;
    actions: MaterializeAction[];
    warnings: string[];
    autoUpgradedToIsolated: boolean;
}

export interface RuntimeLibLayout {
    root: string;
    skillsDir: string;
    mcpDir: string;
    promptsDir: string;
    hooksDir: string;
    toolsDir: string;
}

function resolveMaterializedEnvValues(opts: {
    required?: string[];
    optional?: string[];
    launchOverrides?: Record<string, string>;
}): Record<string, string> {
    const declaredKeys = Array.from(new Set([
        ...(opts.required ?? []),
        ...(opts.optional ?? []),
        ...Object.keys(opts.launchOverrides ?? {}),
    ]));

    const values: Record<string, string> = {};
    for (const key of declaredKeys) {
        if (opts.launchOverrides && Object.prototype.hasOwnProperty.call(opts.launchOverrides, key)) {
            values[key] = opts.launchOverrides[key];
            continue;
        }

        const processValue = process.env[key];
        if (processValue !== undefined) {
            values[key] = processValue;
        }
    }

    return values;
}

function buildHooksSettings(hooks?: AgentDockerConfig['hooks']): Record<string, unknown> {
    const normalizedHooks = hooks
        ? {
            preToolUse: hooks.preToolUse?.map((hook) => ({
                ...hook,
                matcher: hook.matcher ?? '*',
            })),
            postToolUse: hooks.postToolUse?.map((hook) => ({
                ...hook,
                matcher: hook.matcher ?? '*',
            })),
            stop: hooks.stop,
        }
        : undefined;

    return buildHooksSettingsContent(normalizedHooks);
}

export interface BuildAgentWorkspacePlanFromGenomeContext {
    agentId: string;
    repoRoot: string;
    specId?: string;
    workspaceMode?: WorkspaceMode;
    runtimeLibRoot?: string;
    repoConfigRoot?: string;
    launchOverrides?: {
        env?: Record<string, string>;
        allowedSkills?: string[];
    };
}

function resolveGenomeDisplayName(genomeSpec: GenomeSpec): string {
    return genomeSpec.displayName
        ?? genomeSpec.teamRole
        ?? genomeSpec.baseRoleId
        ?? 'agent';
}

function resolveGenomeEnv(genomeSpec: GenomeSpec): AgentDockerConfig['env'] | undefined {
    const genomeEnv = (genomeSpec as unknown as {
        env?: { required?: string[]; optional?: string[]; requiredEnv?: string[]; optionalEnv?: string[] };
    }).env;

    if (!genomeEnv) return undefined;

    return {
        required: genomeEnv.requiredEnv ?? genomeEnv.required,
        optional: genomeEnv.optionalEnv ?? genomeEnv.optional,
    };
}

function defaultRuntimeLibRoot(): string {
    return join(configuration.ahaHomeDir, 'runtime-lib');
}

export function getRuntimeLibLayout(runtimeLibRoot: string): RuntimeLibLayout {
    return {
        root: runtimeLibRoot,
        skillsDir: join(runtimeLibRoot, 'skills'),
        mcpDir: join(runtimeLibRoot, 'mcp'),
        promptsDir: join(runtimeLibRoot, 'prompts'),
        hooksDir: join(runtimeLibRoot, 'hooks'),
        toolsDir: join(runtimeLibRoot, 'tools'),
    };
}

export function ensureRuntimeLibStructure(runtimeLibRoot: string): RuntimeLibLayout {
    const layout = getRuntimeLibLayout(runtimeLibRoot);
    for (const dir of Object.values(layout)) {
        mkdirSync(dir, { recursive: true });
    }
    return layout;
}

export function resolveMaterializationPolicy(
    config: AgentDockerConfig,
    resourceType: RuntimeLibResourceType,
    resourceName?: string,
): MaterializationMode {
    const policy = config.build?.materializationPolicy;

    if (resourceType === 'skills' && resourceName && policy?.skills?.[resourceName]) {
        return policy.skills[resourceName];
    }

    return policy?.resources?.[resourceType]
        ?? policy?.defaultMode
        ?? 'link';
}

function defaultRepoConfigRoot(repoRoot: string): string {
    return join(repoRoot, '.aha-config');
}

function buildGenomeRefInjection(genomeSpec: GenomeSpec, specId?: string): NonNullable<GenomeSpec['contextInjections']>[number] {
    const resolvedSpecId = specId ?? process.env.AHA_SPEC_ID ?? 'unknown';
    const versionLabel = genomeSpec.version !== undefined ? `v${genomeSpec.version}` : 'unversioned';

    return {
        trigger: 'on_join',
        content: `__genome_ref__\nspecId: ${resolvedSpecId}\nversion: ${versionLabel}`,
    };
}

function buildGenomeSpecSnapshot(genomeSpec: GenomeSpec, specId?: string): GenomeSpec {
    const injected = buildGenomeRefInjection(genomeSpec, specId);
    const existing = genomeSpec.contextInjections ?? [];
    const withoutGenomeRef = existing.filter((entry) => !entry.content.includes('__genome_ref__'));

    return {
        ...genomeSpec,
        contextInjections: [...withoutGenomeRef, injected],
    };
}

function buildGenomeLineagePayload(genomeSpec: GenomeSpec, specId?: string): Record<string, unknown> {
    return {
        specId: specId ?? process.env.AHA_SPEC_ID ?? null,
        namespace: genomeSpec.namespace ?? null,
        version: genomeSpec.version ?? null,
        origin: genomeSpec.provenance?.origin ?? 'original',
        parentId: genomeSpec.provenance?.parentId ?? null,
        mutationNote: genomeSpec.provenance?.mutationNote ?? null,
    };
}

function buildEvalCriteriaMarkdown(genomeSpec: GenomeSpec): string {
    const criteria = genomeSpec.evalCriteria ?? [];
    if (criteria.length === 0) {
        return [
            '# Evaluation Criteria',
            '',
            '_No explicit evalCriteria declared for this genome._',
            '',
        ].join('\n');
    }

    return [
        '# Evaluation Criteria',
        '',
        ...criteria.map((criterion) => `- ${criterion}`),
        '',
    ].join('\n');
}

function resolveWorkspaceMode(input: MaterializeAgentWorkspaceInput): {
    mode: WorkspaceMode;
    autoUpgradedToIsolated: boolean;
    warnings: string[];
} {
    const allowed = input.config.workspace?.allowedModes ?? ['shared', 'isolated'];
    const requested = input.workspaceMode ?? input.config.workspace?.defaultMode ?? 'shared';
    const warnings: string[] = [];

    if (allowed.includes(requested)) {
        return {
            mode: requested,
            autoUpgradedToIsolated: false,
            warnings,
        };
    }

    const fallback = allowed.includes('shared') ? 'shared' : 'isolated';
    warnings.push(`Requested workspace mode "${requested}" is not allowed by package; falling back to "${fallback}"`);
    return {
        mode: fallback,
        autoUpgradedToIsolated: fallback === 'isolated' && requested !== 'isolated',
        warnings,
    };
}

function selectEffectiveSkills(input: MaterializeAgentWorkspaceInput): string[] {
    const declared = input.config.tools?.skills ?? [];
    const override = input.launchOverrides?.allowedSkills;
    if (!override?.length) return declared;

    return declared.filter((skill) => override.includes(skill));
}

export function buildAgentWorkspacePlan(
    input: MaterializeAgentWorkspaceInput,
): MaterializeAgentWorkspaceResult {
    const runtimeLibRoot = input.runtimeLibRoot ?? defaultRuntimeLibRoot();
    const repoConfigRoot = input.repoConfigRoot ?? defaultRepoConfigRoot(input.repoRoot);
    const workspaceResolution = resolveWorkspaceMode(input);

    const runtimeRoot = join(configuration.ahaHomeDir, 'runtime', input.agentId);
    const workspaceRoot = join(runtimeRoot, 'workspace');
    const logsDir = join(runtimeRoot, 'logs');
    const cacheDir = join(runtimeRoot, 'cache');
    const tmpDir = join(runtimeRoot, 'tmp');
    const genomeDir = join(workspaceRoot, '.genome');
    const genomeSpecPath = join(genomeDir, 'spec.json');
    const genomeLineagePath = join(genomeDir, 'lineage.json');
    const genomeEvalCriteriaPath = join(genomeDir, 'eval-criteria.md');
    const commandsDir = join(workspaceRoot, '.claude', 'commands');
    const projectViewPath = join(workspaceRoot, 'project');
    const settingsPath = join(workspaceRoot, '.claude', 'settings.json');
    const envFilePath = join(workspaceRoot, '.aha-agent', 'env.json');
    const mcpConfigPath = join(workspaceRoot, '.aha-agent', 'mcp.json');
    const worktreeRoot = join(configuration.ahaHomeDir, 'worktrees', input.agentId);

    const effectiveCwd = workspaceResolution.mode === 'isolated'
        ? projectViewPath
        : input.repoRoot;

    const actions: MaterializeAction[] = [
        { kind: 'ensure-dir', target: workspaceRoot, reason: 'Agent runtime workspace root' },
        { kind: 'ensure-dir', target: join(workspaceRoot, '.claude'), reason: 'Claude project settings root' },
        { kind: 'ensure-dir', target: commandsDir, reason: 'Visible command/skill directory for this agent' },
        { kind: 'ensure-dir', target: join(workspaceRoot, '.aha-agent'), reason: 'Aha agent-local generated config files' },
        { kind: 'ensure-dir', target: logsDir, reason: 'Per-agent logs' },
        { kind: 'ensure-dir', target: cacheDir, reason: 'Per-agent cache' },
        { kind: 'ensure-dir', target: tmpDir, reason: 'Per-agent temp files' },
        {
            kind: 'write-settings',
            target: settingsPath,
            reason: 'Materialize per-agent effective hook settings',
        },
        {
            kind: 'write-env',
            target: envFilePath,
            reason: 'Materialize agent env contract / launch overrides',
        },
        {
            kind: 'write-mcp-config',
            target: mcpConfigPath,
            reason: 'Materialize effective MCP config for this agent',
        },
        workspaceResolution.mode === 'isolated'
            ? {
                kind: 'create-worktree',
                target: worktreeRoot,
                source: input.repoRoot,
                reason: 'Isolated code working view for this agent',
            }
            : {
                kind: 'attach-repo',
                target: input.repoRoot,
                reason: 'Shared repo working view',
            },
    ];

    for (const skill of selectEffectiveSkills(input)) {
        actions.push({
            kind: 'link-skill',
            source: join(runtimeLibRoot, 'skills', skill),
            target: join(commandsDir, skill),
            reason: 'Expose only package-allowed skills to this agent',
        });
    }

    return {
        agentId: input.agentId,
        workspaceMode: workspaceResolution.mode,
        workspaceRoot,
        effectiveCwd,
        projectViewPath,
        genomeDir,
        genomeSpecPath,
        genomeLineagePath,
        genomeEvalCriteriaPath,
        runtimeLibRoot,
        repoConfigRoot,
        commandsDir,
        settingsPath,
        envFilePath,
        mcpConfigPath,
        logsDir,
        cacheDir,
        tmpDir,
        actions,
        warnings: workspaceResolution.warnings,
        autoUpgradedToIsolated: workspaceResolution.autoUpgradedToIsolated,
    };
}

export function ensureAgentWorkspaceDirs(plan: MaterializeAgentWorkspaceResult): void {
    const dirs = [
        plan.workspaceRoot,
        join(plan.workspaceRoot, '.claude'),
        plan.commandsDir,
        join(plan.workspaceRoot, '.aha-agent'),
        plan.genomeDir,
        plan.logsDir,
        plan.cacheDir,
        plan.tmpDir,
    ];

    for (const dir of dirs) {
        mkdirSync(dir, { recursive: true });
    }
}

function pathEntryExists(path: string): boolean {
    if (existsSync(path)) {
        return true;
    }

    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function removePathEntry(path: string): void {
    try {
        if (lstatSync(path).isSymbolicLink()) {
            unlinkSync(path);
            return;
        }
    } catch {
        return;
    }

    rmSync(path, { recursive: true, force: true });
}

export function copyPrivateResource(sourcePath: string, targetPath: string): void {
    if (pathEntryExists(targetPath)) {
        removePathEntry(targetPath);
    }
    cpSync(sourcePath, targetPath, { recursive: true });
}

export function linkSharedResource(sourcePath: string, targetPath: string): void {
    if (pathEntryExists(targetPath)) {
        try {
            if (lstatSync(targetPath).isSymbolicLink() && readlinkSync(targetPath) === sourcePath) {
                return;
            }
        } catch {
            // best-effort below
        }
        removePathEntry(targetPath);
    }

    try {
        const sourceStat = statSync(sourcePath);
        const linkType = process.platform === 'win32'
            ? 'junction'
            : (sourceStat.isDirectory() ? 'dir' : 'file');
        symlinkSync(sourcePath, targetPath, linkType);
    } catch (error: any) {
        if (error?.code === 'EXDEV') {
            copyPrivateResource(sourcePath, targetPath);
            return;
        }
        throw error;
    }
}

export function materializeAgentWorkspace(
    input: MaterializeAgentWorkspaceInput,
): MaterializeAgentWorkspaceResult {
    const plan = buildAgentWorkspacePlan(input);
    ensureRuntimeLibStructure(plan.runtimeLibRoot);
    ensureAgentWorkspaceDirs(plan);

    const settings = buildHooksSettings(input.config.hooks);
    writeFileSync(plan.settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    const envPayload = {
        required: input.config.env?.required ?? [],
        optional: input.config.env?.optional ?? [],
        launchOverrides: input.launchOverrides?.env ?? {},
        values: resolveMaterializedEnvValues({
            required: input.config.env?.required,
            optional: input.config.env?.optional,
            launchOverrides: input.launchOverrides?.env,
        }),
    };
    writeFileSync(plan.envFilePath, JSON.stringify(envPayload, null, 2), 'utf-8');

    const mcpPayload = {
        mcpServers: input.config.tools?.mcpServers ?? [],
    };
    writeFileSync(plan.mcpConfigPath, JSON.stringify(mcpPayload, null, 2), 'utf-8');

    if (input.genome?.spec) {
        const specSnapshot = buildGenomeSpecSnapshot(input.genome.spec, input.genome.specId);
        writeFileSync(plan.genomeSpecPath, JSON.stringify(specSnapshot, null, 2), 'utf-8');
        writeFileSync(
            plan.genomeLineagePath,
            JSON.stringify(buildGenomeLineagePayload(input.genome.spec, input.genome.specId), null, 2),
            'utf-8',
        );
        writeFileSync(plan.genomeEvalCriteriaPath, buildEvalCriteriaMarkdown(input.genome.spec), 'utf-8');
    }

    if (plan.workspaceMode === 'isolated') {
        if (existsSync(plan.projectViewPath)) {
            rmSync(plan.projectViewPath, { recursive: true, force: true });
        }
        cpSync(input.repoRoot, plan.projectViewPath, { recursive: true });
    }

    for (const action of plan.actions) {
        if (action.kind !== 'link-skill' || !action.source) continue;
        if (!existsSync(action.source)) {
            plan.warnings.push(`Skill source missing: ${action.source}`);
            continue;
        }
        const skillName = basename(action.target);
        const mode = resolveMaterializationPolicy(input.config, 'skills', skillName);
        if (mode === 'copy') {
            copyPrivateResource(action.source, action.target);
        } else {
            linkSharedResource(action.source, action.target);
        }
    }

    return plan;
}

// ── Genome bridge ─────────────────────────────────────────────────────────────

/**
 * Build an AgentDockerConfig from a GenomeSpec, then materialize the workspace.
 *
 * This is the genome-backed entry point for v1 materializer integration.
 * It bridges the high-level GenomeSpec (fetchGenomeSpec result) into the
 * concrete workspace layout defined by the materializer.
 *
 * @param genomeSpec  - The GenomeSpec fetched from genome-hub.
 * @param context     - Runtime context (agentId, repoRoot, optional overrides).
 * @returns           - Fully materialized workspace result (directories created, files written).
 */
export function buildAgentWorkspacePlanFromGenome(
    genomeSpec: GenomeSpec,
    context: BuildAgentWorkspacePlanFromGenomeContext,
): MaterializeAgentWorkspaceResult {
    const hooks: AgentDockerConfig['hooks'] = genomeSpec.hooks
        ? {
            preToolUse: genomeSpec.hooks.preToolUse as AgentHookCommand[] | undefined,
            postToolUse: genomeSpec.hooks.postToolUse as AgentHookCommand[] | undefined,
            stop: genomeSpec.hooks.stop as AgentHookCommand[] | undefined,
        }
        : undefined;

    const config: AgentDockerConfig = {
        kind: 'aha.agent.v1',
        name: resolveGenomeDisplayName(genomeSpec),
        runtime: (genomeSpec.runtimeType as AgentRuntime | undefined) ?? 'claude',
        tools: {
            mcpServers: genomeSpec.mcpServers,
            skills: genomeSpec.skills,
        },
        hooks,
        env: resolveGenomeEnv(genomeSpec),
        workspace: {
            defaultMode: context.workspaceMode ?? 'shared',
            allowedModes: ['shared', 'isolated'],
        },
    };

    return materializeAgentWorkspace({
        agentId: context.agentId,
        repoRoot: context.repoRoot,
        runtime: config.runtime,
        config,
        genome: {
            spec: genomeSpec,
            specId: context.specId,
        },
        workspaceMode: context.workspaceMode,
        runtimeLibRoot: context.runtimeLibRoot,
        repoConfigRoot: context.repoConfigRoot,
        launchOverrides: context.launchOverrides,
    });
}
