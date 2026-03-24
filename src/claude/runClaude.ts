import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentState, Metadata } from '@/api/types';
// @ts-ignore
import packageJson from '../../package.json';
import { Credentials, readSettings } from '@/persistence';
import { EnhancedMode, PermissionMode } from './loop';
import { TeamMessageStorage, TeamMessage } from './team/teamMessageStorage';

import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import { extractSDKMetadataAsync } from '@/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { startAhaServer } from '@/claude/utils/startAhaServer';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { resolve } from 'node:path';
import {
    buildAgentHandshakeContent,
    getRolePermissions,
    generateRolePrompt,
    isBootstrapRole,
    isBypassRole,
    isCoordinatorRole,
    KanbanContext
} from './team/roles';
import { DEFAULT_ROLES } from './team/roles.config';
import { TaskStateManager } from './utils/taskStateManager';
import { resolveModel, setModelRouteRules } from './utils/modelRouter';
import { StatusReporter, createStatusReporter } from './team/statusReporter';
import { emitTraceEvent } from '@/trace/traceEmitter';
import { TraceEventKind } from '@/trace/traceTypes';
import { ApprovalWorkflow, createApprovalWorkflow } from './team/approvalWorkflow';
import { fetchGenomeSpec, fetchGenomeFeedbackData } from './utils/fetchGenome';
import { buildGenomeInjection } from './utils/buildGenomeInjection';
import { buildAgentWorkspacePlanFromGenome, MaterializeAgentWorkspaceResult, withDefaultAgentSkills } from '@/agentDocker/materializer';
import { filterMaterializedMcpServers, readMaterializedMcpServerNames } from '@/agentDocker/runtimeConfig';
import { ensureCurrentSessionRegisteredToTeam } from './team/ensureTeamMembership';
import { buildModelSelfAwarenessPrompt, resolveContextWindowTokens, DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS } from '@/utils/modelContextWindows';
import { resolveInitialModelOverrides } from './utils/modelOverrides';
import { buildMountedAgentPrompt } from '@/utils/buildMountedAgentPrompt';

export interface StartOptions {
    model?: string
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'daemon' | 'terminal'
    sessionTag?: string
}

/**
 * Format a team message for injection into Claude's context
 */
function formatTeamMessage(
    message: any, // TeamMessage type
    teamId: string,
    myRole: string,
    isMentioned: boolean
): string {
    const mentionTag = isMentioned ? '[MENTIONED]' : '';
    const urgentTag = message.metadata?.priority === 'urgent' ? '[URGENT]' : '';

    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📨 Team Message ${mentionTag} ${urgentTag}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
From: ${message.fromDisplayName || message.fromRole || message.fromSessionId?.substring(0, 8) || 'Unknown'} [role: ${message.fromRole || 'unknown'}]
Type: ${message.type || 'chat'}
Time: ${new Date(message.timestamp).toLocaleString()}

${message.content}

${isMentioned ? `⚠️  You were mentioned in this message.
💡 Your role: ${myRole}
📌 Please respond to this message in the team chat.` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
}

function escapeInjectedContextForTransport(text: string): string {
    return text.replace(/\\/g, '\\\\');
}

function resolveEnvPermissionMode(rawMode?: string): StartOptions['permissionMode'] | undefined {
    if (!rawMode) {
        return undefined;
    }
    const normalized = rawMode.trim().toLowerCase();
    switch (normalized) {
        case 'default':
            return 'default';
        case 'plan':
            return 'plan';
        case 'accept':
        case 'accept-edits':
        case 'acceptedits':
            return 'acceptEdits';
        case 'yolo':
        case 'safe-yolo':
        case 'safe_yolo':
        case 'safe':
        case 'bypass':
        case 'bypasspermissions':
        case 'danger':
            return 'bypassPermissions';
        default:
            logger.debug(`[START] Ignoring unknown AHA_PERMISSION_MODE value: ${rawMode}`);
            return undefined;
    }
}

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = options.sessionTag || randomUUID();

    if (!options.permissionMode) {
        const envPermissionMode = resolveEnvPermissionMode(process.env.AHA_PERMISSION_MODE);
        if (envPermissionMode) {
            options.permissionMode = envPermissionMode;
            logger.debug(`[START] Permission mode initialized from env: ${envPermissionMode}`);
        }
    }
    if (!options.permissionMode && process.env.AHA_ROOM_ID) {
        options.permissionMode = 'bypassPermissions';
        logger.debug(`[START] Permission mode defaulted to bypass for team session ${process.env.AHA_ROOM_ID}`);
    }

    // Log environment info at startup
    logger.debugLargeJson('[START] Aha process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${options.startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements
    if (options.startedBy === 'daemon' && options.startingMode === 'local') {
        logger.debug('Daemon spawn requested with local mode - forcing remote mode');
        options.startingMode = 'remote';
        // TODO: Eventually we should error here instead of silently switching
        // throw new Error('Daemon-spawned sessions cannot use local/interactive mode');
    }

    // Create session service
    const api = await ApiClient.create(credentials);

    // Create a new session
    let state: AgentState = {};
    const recoverAhaSessionId = process.env.AHA_RECOVER_SESSION_ID?.trim() || undefined;

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexepcted since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/Shiyao-Huang/aha/issues/new/choose`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    // Create machine if it doesn't exist
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        ahaHomeDir: configuration.ahaHomeDir,
        ahaLibDir: projectPath(),
        ahaToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        processStartedAt: Date.now(),
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        sessionTag,
    };
    if (process.env.AHA_TEAM_MEMBER_ID) {
        metadata.memberId = process.env.AHA_TEAM_MEMBER_ID;
    }
    if (process.env.AHA_AGENT_ROLE) {
        metadata.role = process.env.AHA_AGENT_ROLE;
        logger.debug(`[runClaude] Setting metadata.role from env: ${process.env.AHA_AGENT_ROLE}`);
    }
    const roomIdFromEnv = process.env.AHA_ROOM_ID;
    if (roomIdFromEnv) {
        metadata.teamId = roomIdFromEnv;
        metadata.roomId = roomIdFromEnv;
        logger.debug(`[runClaude] Setting metadata.teamId from env: ${roomIdFromEnv}`);
    }
    const executionPlaneFromEnv = process.env.AHA_EXECUTION_PLANE as 'bypass' | 'mainline' | undefined;
    if (executionPlaneFromEnv) {
        metadata.executionPlane = executionPlaneFromEnv;
        logger.debug(`[runClaude] Setting metadata.executionPlane from env: ${executionPlaneFromEnv}`);
    }
    logger.debug(`[runClaude] Final metadata before session creation:`, { role: metadata.role, teamId: metadata.teamId });
    if (process.env.AHA_ROOM_NAME) {
        metadata.roomName = process.env.AHA_ROOM_NAME;
    }
    if (process.env.AHA_AGENT_MODEL) {
        metadata.modelOverride = process.env.AHA_AGENT_MODEL;
    }
    if (process.env.AHA_FALLBACK_AGENT_MODEL) {
        metadata.fallbackModelOverride = process.env.AHA_FALLBACK_AGENT_MODEL;
    }
    // Priority: AHA_SESSION_NAME > AHA_ROOM_NAME
    metadata.name = process.env.AHA_SESSION_NAME || process.env.AHA_ROOM_NAME;
    if (metadata.name) {
        logger.debug(`[runClaude] Setting metadata.name: ${metadata.name}`);
    }
    const response = await api.getOrCreateSession({ sessionId: recoverAhaSessionId, tag: sessionTag, metadata, state });
    logger.debug(`Session created: ${response.id}`);
    logger.debug(`[runClaude] Response metadata from server:`, { role: response.metadata?.role, teamId: response.metadata?.teamId });

    const storedClaudeSessionId = response.metadata?.claudeSessionId;
    const hasExplicitResume = !!options.claudeArgs?.includes('--resume');
    if (storedClaudeSessionId && !hasExplicitResume) {
        options.claudeArgs = ['--resume', storedClaudeSessionId, ...(options.claudeArgs || [])];
        logger.debug(`[runClaude] Reusing stored Claude session for resume: ${storedClaudeSessionId}`);
    }

    // Create realtime session
    const session = api.sessionSyncClient(response);

    // Note: teamId/role from env vars are used internally, Kanban will update metadata

    // Always report to daemon if it exists
    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    // Extract SDK metadata in background and update session when ready
    extractSDKMetadataAsync(async (sdkMetadata) => {
        logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
        try {
            // Update session metadata with tools and slash commands
            api.sessionSyncClient(response).updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                tools: sdkMetadata.tools,
                slashCommands: sdkMetadata.slashCommands
            }));
            logger.debug('[start] Session metadata updated with SDK capabilities');
        } catch (error) {
            logger.debug('[start] Failed to update session metadata:', error);
        }
    });

    // Create message queue for managing state updates
    const messageQueue = new MessageQueue2<EnhancedMode>(
        (mode) => hashObject(mode)
    );

    // Start Aha MCP server — pass a ref so genome spec (loaded below) can be written in later
    const _genomeSpecRef: { current: import('../api/types/genome').GenomeSpec | null | undefined } = { current: undefined };
    const ahaServer = await startAhaServer(api, session, _genomeSpecRef);
    logger.debug(`[START] Aha MCP server started at ${ahaServer.url}`);
    const desktopMcpUrl = process.env.AHA_DESKTOP_MCP_URL;
    if (desktopMcpUrl) {
        logger.debug(`[START] Desktop MCP server detected at ${desktopMcpUrl}`);
    }

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: options.startingMode !== 'remote'
    }));

    // Start caffeinate to prevent sleep on macOS
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.infoDeveloper('Sleep prevention enabled (macOS)');
    }

    // MessageQueue2 is already initialized above

    // Forward messages to the queue
    let currentPermissionMode = options.permissionMode;

    // Initialize model: priority = CLI args > session.modelOverride > role default > undefined
    // Session modelOverride is set by master/supervisor via update_agent_model MCP tool or aha agents update --model
    const initialModelOverrides = resolveInitialModelOverrides(session.getMetadata());
    let currentModel = options.model || initialModelOverrides.model;
    if (initialModelOverrides.model && !options.model) {
        logger.debug(`[runClaude] Using model override from session metadata: ${initialModelOverrides.model}`);
    } else if (options.model) {
        logger.debug(`[runClaude] Using model from CLI options: ${options.model}`);
    } else {
        logger.debug(`[runClaude] No model override, using Claude default`);
    }

    let currentFallbackModel: string | undefined = initialModelOverrides.fallbackModel;
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt

    // Implant Context (Rules & Preferences)
    let currentAppendSystemPrompt: string | undefined = undefined;
    let currentModelAwarenessPrompt: string | undefined = undefined;
    try {
        const rulesConfig = await api.kvGet('config.rules');
        const preferencesConfig = await api.kvGet('config.preferences');

        let initialContext = "";
        if (rulesConfig?.value) initialContext += `\n\n<global_rules>\n${rulesConfig.value}\n</global_rules>`;
        if (preferencesConfig?.value) initialContext += `\n\n<user_preferences>\n${preferencesConfig.value}\n</user_preferences>`;

        if (initialContext) {
            currentAppendSystemPrompt = initialContext;
            logger.debug('[runClaude] Implanted context into system prompt');
        }
    } catch (e) {
        logger.debug('[runClaude] Failed to implant context:', e);
    }
    const mountedAgentPrompt = buildMountedAgentPrompt(process.env.AHA_AGENT_PROMPT);
    if (mountedAgentPrompt) {
        currentAppendSystemPrompt = currentAppendSystemPrompt
            ? `${currentAppendSystemPrompt}\n\n${mountedAgentPrompt}`
            : mountedAgentPrompt;
        logger.debug('[runClaude] Mounted launch-time agent context into system prompt');
    }
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools

    const syncModelAwareness = () => {
        const contextWindowTokens = resolveContextWindowTokens(currentModel);
        currentModelAwarenessPrompt = buildModelSelfAwarenessPrompt({
            modelId: currentModel,
            fallbackModelId: currentFallbackModel,
            contextWindowTokens,
        }) || undefined;

        try {
            session.updateMetadata((currentMetadata) => {
                const nextMetadata = { ...((currentMetadata || {}) as any) };
                if (typeof contextWindowTokens === 'number') {
                    nextMetadata.contextWindowTokens = contextWindowTokens;
                } else {
                    delete nextMetadata.contextWindowTokens;
                }
                // Write resolvedModel so sessions show can surface it
                if (currentModel) {
                    nextMetadata.resolvedModel = currentModel;
                } else {
                    delete nextMetadata.resolvedModel;
                }
                return nextMetadata;
            });
        } catch (error) {
            logger.debug('[runClaude] Failed to sync model awareness metadata:', error);
        }
    };

    const composeAppendSystemPrompt = (basePrompt?: string, rolePrompt?: string): string | undefined => {
        const blocks = [basePrompt, currentModelAwarenessPrompt, rolePrompt]
            .map((block) => block?.trim())
            .filter((block): block is string => Boolean(block));

        return blocks.length > 0 ? blocks.join('\n\n') : undefined;
    };

    // ── Genome 启动注入（Tier 2–4）────────────────────────────────────────────
    // 在 session 启动阶段就把 model / permissionMode / tools 从 genome spec 注入，
    // 这样整个 session 生命周期都生效，不只是 team join 时。
    // Tier 1（prompt）在下面 team join 的时候注入，因为 instructions 是在那时构建的。
    const _explicitSpecId = process.env.AHA_SPEC_ID;
    const _roleBasedSpecId = !_explicitSpecId && process.env.AHA_AGENT_ROLE
        ? `@official/${process.env.AHA_AGENT_ROLE}`
        : undefined;
    const _genomeSpecId = _explicitSpecId ?? _roleBasedSpecId;
    const [_genomeSpec, _genomeFeedbackData] = _genomeSpecId
        ? await Promise.all([
            fetchGenomeSpec(credentials.token, _genomeSpecId).catch((err) => {
                // AHA_GENOME_FALLBACK=1 → silent (production mode)
                // default (testing) → warn so we can see genome loading failures
                if (process.env.AHA_GENOME_FALLBACK !== '1') {
                    console.warn(`[GENOME] ⚠️  Failed to load genome spec (specId=${_genomeSpecId}): ${err?.message ?? err}`);
                    console.warn(`[GENOME]    Running without genome DNA. Fix genome-hub or set AHA_GENOME_FALLBACK=1 to silence.`);
                }
                return null;
            }),
            fetchGenomeFeedbackData(credentials.token, _genomeSpecId).catch(() => null),
        ])
        : [null, null] as const;

    // Write into the ref so startAhaServer's tools (create_agent etc.) can use genome data
    _genomeSpecRef.current = _genomeSpec;
    const startupRole = process.env.AHA_AGENT_ROLE || session.getMetadata()?.role;

    if (_genomeSpec) {
        // Tier 2 — 模型覆盖
        if (_genomeSpec.modelId && !currentModel) {
            currentModel = _genomeSpec.modelId;
            logger.debug(`[genome] Model set from genome: ${currentModel}`);
        }
        if (_genomeSpec.fallbackModelId && !currentFallbackModel) {
            currentFallbackModel = _genomeSpec.fallbackModelId;
            logger.debug(`[genome] Fallback model set from genome: ${currentFallbackModel}`);
        }

        // Tier 3 — 工具访问控制
        // Core team tools that EVERY agent must have — kanban, messaging, help.
        // Without these, agents become isolated islands that can't collaborate.
        const CORE_TEAM_TOOLS = [
            // Task lifecycle (kanban)
            'create_task', 'update_task', 'list_tasks', 'start_task', 'complete_task',
            'report_blocker', 'resolve_blocker', 'add_task_comment',
            'create_subtask', 'list_subtasks', 'delete_task',
            // Team collaboration
            'send_team_message', 'get_team_info',
            // Context & self-awareness
            'get_context_status', 'change_title',
            // Help lane
            'request_help',
        ];
        const ignoreGenomeToolConstraints = isBypassRole(startupRole, _genomeSpec) && startupRole === 'supervisor';
        if (_genomeSpec.allowedTools?.length) {
            if (ignoreGenomeToolConstraints) {
                logger.debug('[genome] Ignoring genome allowedTools for supervisor so it can inspect raw logs directly');
            } else {
                // Merge core team tools into the genome's allowedTools whitelist
                // so agents never lose kanban/messaging/help capabilities
                const merged = Array.from(new Set([...CORE_TEAM_TOOLS, ..._genomeSpec.allowedTools]));
                currentAllowedTools = merged;
                logger.debug(`[genome] Allowed tools set from genome (${_genomeSpec.allowedTools.length} custom + ${CORE_TEAM_TOOLS.length} core = ${merged.length} total)`);
            }
        }
        if (_genomeSpec.disallowedTools?.length) {
            if (ignoreGenomeToolConstraints) {
                logger.debug('[genome] Ignoring genome disallowedTools for supervisor so it can inspect raw logs directly');
            } else {
                currentDisallowedTools = _genomeSpec.disallowedTools;
                logger.debug(`[genome] Disallowed tools set from genome: ${currentDisallowedTools.join(', ')}`);
            }
        }

        // Always block Claude Code's BUILT-IN team tools — our agents use Aha MCP team tools instead.
        // Without this, agents confuse SendMessage (CC native) with send_team_message (Aha MCP),
        // causing "Not in a team context" errors.
        const CC_NATIVE_TEAM_TOOLS = ['SendMessage', 'TeamCreate', 'TeamDelete'];
        currentDisallowedTools = [...(currentDisallowedTools || []), ...CC_NATIVE_TEAM_TOOLS];

        // Tier 4 — 权限模式（优先级低于 CLI 参数）
        if (_genomeSpec.permissionMode && !currentPermissionMode) {
            currentPermissionMode = _genomeSpec.permissionMode;
            logger.debug(`[genome] Permission mode set from genome: ${currentPermissionMode}`);
        }

        logger.debug(`[genome] Genome spec applied at startup (specId=${_genomeSpecId})`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Genome Tier 8–9：Hooks + Skills + maxTurns + env 注入 ───────────────
    // 将 genome/launch config 的 hooks/env 物化为 .aha/runtime/<agentId>/workspace/.claude/ 下的持久文件，
    // skills 注入 appendSystemPrompt；settingsPath 传递给 launcher 的 --settings 标志。
    const _agentId = process.env.AHA_TEAM_MEMBER_ID || response.id;
    let _workspacePlan: MaterializeAgentWorkspaceResult | null = null;
    let _maxTurns: number | undefined = _genomeSpec?.maxTurns;

    if (_genomeSpec) {
        // Materialize workspace (hooks → settings.json, env → env.json, skills → commands/)
        try {
            _workspacePlan = buildAgentWorkspacePlanFromGenome(_genomeSpec, {
                agentId: _agentId,
                repoRoot: workingDirectory,
                launchOverrides: { env: options.claudeEnvVars },
            });
            logger.debug(`[genome] Workspace materialized: ${_workspacePlan.workspaceRoot}`);
            logger.debug(`[genome] Settings path: ${_workspacePlan.settingsPath}`);
            for (const w of _workspacePlan.warnings) {
                logger.debug(`[genome] Workspace warning: ${w}`);
            }
        } catch (err) {
            logger.error('[genome] Failed to materialize workspace:', err);
            throw err;
        }

        // Skills → system prompt injection (agent awareness)
        const effectiveSkills = withDefaultAgentSkills(_genomeSpec.skills);
        if (effectiveSkills.length > 0) {
            const skillsText = [
                '## Available Agent Skills',
                '',
                ...effectiveSkills.map((s: string) => `- /${s}`),
                '',
                'Use these skills when they match the current task.',
            ].join('\n');
            currentAppendSystemPrompt = (currentAppendSystemPrompt || '') + '\n\n' + skillsText;
            logger.debug('[genome] Skills injection appended to system prompt');
        }
    }

    if (_maxTurns) {
        logger.debug(`[genome] maxTurns from genome: ${_maxTurns}`);
    }

    // Pre-materialized workspace: AHA_SETTINGS_PATH is set by `aha agents spawn`
    // when materializing a local agent.json without uploading to genome-hub.
    // Only applies when no genome spec was loaded (genome takes precedence).
    const _prebuiltSettingsPath = (!_genomeSpec && process.env.AHA_SETTINGS_PATH)
        ? process.env.AHA_SETTINGS_PATH
        : undefined;
    const _prebuiltMcpServerNames = (!_genomeSpec && process.env.AHA_AGENT_MCP_CONFIG_PATH)
        ? readMaterializedMcpServerNames(process.env.AHA_AGENT_MCP_CONFIG_PATH)
        : [];
    if (_prebuiltSettingsPath) {
        logger.debug(`[workspace] Using pre-materialized settings: ${_prebuiltSettingsPath}`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Model Router（Tier 2 扩展）────────────────────────────────────────────
    // 从 KV 加载自定义路由规则（如果有），然后用 resolveModel() 决定最终模型。
    // 优先级: genome.modelId > KV rules > built-in defaults
    // 只有在 currentModel 还没被 CLI/session 覆盖时才使用路由规则。
    try {
        const modelRoutesKv = await api.kvGet('config.model-routes');
        if (modelRoutesKv?.value) {
            setModelRouteRules(JSON.parse(modelRoutesKv.value));
        }
    } catch (e) {
        logger.debug('[modelRouter] Failed to load KV model routes (non-fatal):', e);
    }

    // 只有没有手动指定 model 时才走路由逻辑
    if (!currentModel) {
        const roleForRouter = process.env.AHA_AGENT_ROLE || session.getMetadata()?.role;
        const execPlane = (process.env.AHA_EXECUTION_PLANE as 'bypass' | 'mainline' | undefined)
            || (process.env.AHA_ROOM_ID ? 'mainline' : undefined);

        const resolved = resolveModel({
            role: roleForRouter,
            executionPlane: execPlane,
            genomeModelId: _genomeSpec?.modelId,
            genomeModelProvider: _genomeSpec?.modelProvider,
        });

        if (resolved.isSupported) {
            currentModel = resolved.modelId;
            logger.debug(`[modelRouter] Resolved model: ${resolved.provider}/${resolved.modelId} (role=${roleForRouter}, plane=${execPlane})`);
        } else {
            // 非 Anthropic provider 降级：记录警告，使用 fallback model
            logger.debug(
                `[modelRouter] Provider not supported, falling back to anthropic/${resolved.fallbackModelId}. ` +
                `(genome requested: ${_genomeSpec?.modelProvider}/${_genomeSpec?.modelId})`
            );
            currentModel = resolved.fallbackModelId;
            if (!currentFallbackModel) {
                currentFallbackModel = resolved.fallbackModelId;
            }
        }
    }
    syncModelAwareness();
    // ─────────────────────────────────────────────────────────────────────────

    // Initialize role from environment variables first, fallback to session metadata
    logger.debug(`[runClaude] Initializing role - env: ${process.env.AHA_AGENT_ROLE}, metadata: ${session.getMetadata()?.role}`);
    let currentRole: string | undefined = process.env.AHA_AGENT_ROLE || session.getMetadata()?.role;
    if (currentRole) {
        logger.debug(`[runClaude] Initialized with role: ${currentRole}`);
    }

    // Initialize teamId from environment variables first, fallback to session metadata
    logger.debug(`[runClaude] Initializing teamId - env: ${process.env.AHA_ROOM_ID}, metadata: ${session.getMetadata()?.teamId}`);
    let currentTeamId: string | undefined = process.env.AHA_ROOM_ID || session.getMetadata()?.teamId;
    let cleanupTeamHandling: (() => void) | undefined;

    // TaskStateManager for Kanban context management
    let taskStateManager: TaskStateManager | undefined;

    // StatusReporter for automatic status updates to team
    let statusReporter: StatusReporter | undefined;

    // ApprovalWorkflow for Master/Coordinator roles
    let approvalWorkflow: ApprovalWorkflow | undefined;

    // Function to setup/update team handling
    const updateTeamHandling = async (teamId: string | undefined, role: string | undefined, isNewJoin: boolean) => {
        // Cleanup existing listener if any
        if (cleanupTeamHandling) {
            cleanupTeamHandling();
            cleanupTeamHandling = undefined;
        }

        if (teamId && role) {
            logger.debug(`[runClaude] Session is part of team ${teamId} with role ${role}`);

            // Initialize TaskStateManager for Kanban context
            taskStateManager = new TaskStateManager(api, teamId, response.id, role);

            // Set up state change callback for real-time updates
            taskStateManager.setOnStateChange((change) => {
                logger.debug(`[runClaude] Kanban state change: ${change.type} on ${change.taskTitle}`);
            });

            // Initialize StatusReporter for automatic status updates
            statusReporter = createStatusReporter(api, taskStateManager, teamId, response.id, role);
            logger.debug(`[runClaude] StatusReporter initialized for role ${role}`);

            const membershipResult = await ensureCurrentSessionRegisteredToTeam({
                api,
                teamId,
                sessionId: response.id,
                role,
                metadata: session.getMetadata() || metadata,
                taskStateManager,
                specId: _genomeSpecId || undefined,
            });
            logger.debug(
                `[runClaude] Team membership sync result: registered=${membershipResult.registered}, alreadyPresent=${membershipResult.alreadyPresent}`
            );

            // Initialize ApprovalWorkflow for coordination roles (master, orchestrator, team-lead)
            if (isCoordinatorRole(role, _genomeSpec)) {
                logger.debug(`[runClaude] ApprovalWorkflow initialized for coordinator role ${role}`);
            }

            // Initialize local storage
            const teamStorage = new TeamMessageStorage(process.cwd());

            const summarizeHistory = (history: TeamMessage[]) => {
                if (!history.length) {
                    return '(No recent history)';
                }

                const tail = history.slice(-10);
                const typeCounts = tail.reduce<Record<string, number>>((acc, message) => {
                    acc[message.type] = (acc[message.type] || 0) + 1;
                    return acc;
                }, {});
                const summaryLines = tail.map(message => {
                    const time = new Date(message.timestamp).toLocaleTimeString();
                    const roleLabel = message.fromRole || 'user';
                    const preview = message.shortContent || (message.content || '').replace(/\s+/g, ' ').slice(0, 160);
                    const priority = message.metadata?.priority ? ` [${message.metadata.priority.toUpperCase()}]` : '';
                    return `[${time}] ${roleLabel} · ${message.type}${priority}: ${preview}`;
                });

                const statsText = Object.entries(typeCounts)
                    .map(([type, count]) => `${type}:${count}`)
                    .join(' · ');

                return `${summaryLines.join('\n')}

活跃类型分布: ${statsText || '无'}`;
            };

            // Hydrate remote history when joining a team to avoid stale backlog
            if (isNewJoin) {
                try {
                    const remoteHistory = await api.getTeamMessages(teamId, { limit: 200 });
                    const messages = remoteHistory?.messages || [];
                    if (messages.length) {
                        await teamStorage.hydrateFromServer(teamId, messages);
                        logger.debug(`[runClaude] Hydrated ${messages.length} remote team messages for ${teamId}`);
                    } else {
                        logger.debug('[runClaude] Remote team history empty');
                    }
                } catch (error) {
                    logger.debug('[runClaude] Failed to hydrate remote team history:', error);
                }
            }

            // Register RPC handler for getting messages
            session.rpcHandlerManager.registerHandler('team_get_messages', async (params: { teamId: string, limit: number, before?: string }) => {
                logger.debug(`[runClaude] RPC team_get_messages for team ${params.teamId}`);
                return await teamStorage.getMessages(params.teamId, params.limit, params.before);
            });

            // Subscribe to team-message events
            const teamMessageListener = async (message: any) => {
                try {
                    // Check if this message belongs to the current team
                    if (message.teamId === teamId) {
                        console.log(`[Team] 📨 Received message from ${message.fromSessionId} (${message.fromRole})`);
                        logger.debugLargeJson('[runClaude] Team message received:', message);

                        // Save to local storage
                        await teamStorage.saveMessage(teamId, message);
                        logger.debug(`[runClaude] Saved team message ${message.id} to local storage`);

                        // Self-filter: IGNORE messages from myself
                        if (message.fromSessionId === response.id) {
                            logger.debug(`[Team] Ignoring my own message`);
                            return;
                        }

                        // Check for direct session ID mention OR role name mention (e.g. @builder)
                        const contentLower = (message.content || '').toLowerCase();
                        const isRoleMentioned = role && contentLower.includes(`@${role.toLowerCase()}`);
                        const isMentioned = message.mentions?.includes(response.id) || isRoleMentioned || false;

                        const fromRole = message.fromRole;
                        logger.debug(`[runClaude] Injecting team message (from:${fromRole || 'user'}, mentioned:${isMentioned})`);

                        // Format the message for injection
                        const formattedMessage = formatTeamMessage(message, teamId!, role!, isMentioned);

                        // Get Kanban context for role-aware prompt injection
                        let kanbanContext: KanbanContext | undefined;
                        if (taskStateManager) {
                            try {
                                kanbanContext = await taskStateManager.getFilteredContext();
                                logger.debug(`[runClaude] Got Kanban context: ${kanbanContext.myTasks.length} my tasks, ${kanbanContext.availableTasks.length} available`);
                            } catch (err) {
                                logger.debug('[runClaude] Failed to get Kanban context:', err);
                            }
                        }

                        // Generate role prompt to include in system prompt
                        const sessionMetadataForTeamMsg = session.getMetadata() || {} as any;
                        // Ensure we have role and teamId in metadata for generateRolePrompt
                        if (!sessionMetadataForTeamMsg.role) sessionMetadataForTeamMsg.role = role;
                        if (!sessionMetadataForTeamMsg.teamId) sessionMetadataForTeamMsg.teamId = teamId;
                        const rolePromptForTeamMsg = generateRolePrompt(sessionMetadataForTeamMsg, kanbanContext, _genomeSpec ?? undefined, _genomeFeedbackData);
                        const { disallowedTools: roleDisallowedToolsForMsg } = getRolePermissions(role, currentPermissionMode);

                        // Inject into message queue using the SAME mode as the initial context injection
                        // CRITICAL: Do NOT regenerate role prompt here — dynamic Kanban context changes
                        // the mode hash, causing claudeRemote to restart the conversation and lose context.
                        // Instead, just push the formatted message with a stable mode.
                        const enhancedMode: EnhancedMode = {
                            permissionMode: currentPermissionMode || 'default',
                            model: currentModel,
                            fallbackModel: currentFallbackModel,
                            customSystemPrompt: currentCustomSystemPrompt,
                            appendSystemPrompt: currentAppendSystemPrompt || '',
                            allowedTools: currentAllowedTools,
                            disallowedTools: currentDisallowedTools || []
                        };

                        messageQueue.push(formattedMessage, enhancedMode);
                        console.log('[Team] ✅ Message injected into queue');
                        logger.debug('[runClaude] Team message injected into queue (stable mode hash)');
                    }
                } catch (error) {
                    console.error('[Team] Error processing message:', error);
                    logger.debug('[runClaude] Error processing team message:', error);
                }
            };

            session.on('team-message', teamMessageListener);
            cleanupTeamHandling = () => {
                session.off('team-message', teamMessageListener);
            };

            // === Handshake & Injection ===
            if (isNewJoin) {
                logger.debug(`[runClaude] Performing handshake and context injection for team ${teamId}`);

                // 1. Send Handshake - Dynamic from GenomeSpec + role fallback + @help
                try {
                    const roleDef = DEFAULT_ROLES[role!];
                    const roleTitle = _genomeSpec?.displayName || roleDef?.name || role;

                    // Dynamic: pull responsibilities and capabilities from GenomeSpec (the DNA),
                    // fall back to static role definitions only when no genome is loaded.
                    const responsibilities: string[] = _genomeSpec?.responsibilities?.slice(0, 3)
                        || roleDef?.responsibilities?.slice(0, 3)
                        || [];
                    const capabilities: string[] = (_genomeSpec as any)?.capabilities || [];
                    const genomeDescription = _genomeSpec?.description;
                    const scope = (_genomeSpec as any)?.scopeOfResponsibility;
                    const scopeSummary = scope?.ownedPaths?.length
                        ? [
                            `Owned paths: ${scope.ownedPaths.join(', ')}`,
                            scope.forbiddenPaths?.length ? `forbidden: ${scope.forbiddenPaths.join(', ')}` : null,
                        ].filter(Boolean).join('; ')
                        : undefined;

                    let introContent: string = '';

                    if (isBootstrapRole(role, _genomeSpec)) {
                        logger.debug('[runClaude] Bootstrap role — skipping team handshake (silent mode)');
                        console.log(`[Team] 🔇 ${roleTitle} working silently (bootstrap mode)`);
                    } else {
                        const roleSummary = genomeDescription || roleDef?.name || roleTitle;
                        introContent = buildAgentHandshakeContent({
                            role: role!,
                            roleTitle,
                            isCoordinator: isCoordinatorRole(role, _genomeSpec),
                            isBootstrap: isBootstrapRole(role, _genomeSpec),
                            roleDescription: roleSummary,
                            responsibilities,
                            capabilities,
                            scopeSummary,
                        });
                    }

                    const handshakeMsg = {
                        id: randomUUID(),
                        teamId,
                        content: introContent,
                        type: 'chat' as const,  // Must be 'chat' to match server TeamMessageSchema
                        timestamp: Date.now(),
                        fromSessionId: response.id,
                        fromRole: role,
                        metadata: { type: 'handshake', roleTitle }
                    };
                    if (!isBootstrapRole(role, _genomeSpec)) {
                        await api.sendTeamMessage(teamId, handshakeMsg);
                        logger.debug('[runClaude] Sent handshake message to team');
                        console.log(`[Team] 📢 ${roleTitle} announced presence in team chat`);

                        // ── Trace: handshake_sent ───────────────────────────
                        try {
                            emitTraceEvent(
                                TraceEventKind.handshake_sent,
                                'runClaude',
                                {
                                    team_id: teamId,
                                    session_id: response.id,
                                },
                                `${roleTitle} (${role}) sent handshake to team ${teamId}`,
                                { attrs: { role, roleTitle } },
                            );
                        } catch { /* trace must never break main flow */ }
                    }
                } catch (e) {
                    logger.debug('[runClaude] Failed to send handshake:', e);
                    console.log(`[Team] ⚠️ Failed to send handshake for ${role}`);
                }

                // 2. Inject Context (Team Artifact + Recent Messages)
                // Even if artifact fetch fails, we must still send a kickstart message
                let teamData: any = null;
                let teamName = 'Team';
                let historyText = '(No recent history)';

                // Try to fetch team artifact (optional - may fail for new teams)
                try {
                    const artifact = await api.getArtifact(teamId);
                    teamData = artifact.body;
                    teamName = typeof artifact.header === 'string' ? artifact.header : 'Team';
                    logger.debug('[runClaude] Successfully fetched team artifact');
                } catch (e) {
                    logger.debug('[runClaude] Team artifact not available (this is OK for new teams):', e);
                }

                // Try to get recent messages from local storage
                try {
                    const recentMessages = await teamStorage.getRecentContext(teamId, 20);
                    historyText = summarizeHistory(recentMessages);
                } catch (e) {
                    logger.debug('[runClaude] Failed to get recent messages:', e);
                }

                // Filter Kanban Board for Context Isolation (only if we have data)
                let filteredBoard = teamData ? { ...teamData } : { message: 'Team data not yet available. Wait for tasks from Master.' };
                const currentSessionMetadata = (session.getMetadata() || {}) as any;
                if (teamData && !isCoordinatorRole(role, _genomeSpec) && !isBootstrapRole(role, _genomeSpec)) {
                    // Workers only see:
                    // 1. Tasks assigned to them
                    // 2. Unassigned tasks (todo)
                    // 3. High-level team info (goal, members)
                    if (filteredBoard.tasks && Array.isArray(filteredBoard.tasks)) {
                        filteredBoard.tasks = filteredBoard.tasks.filter((t: any) =>
                            t.assigneeId === response.id ||
                            t.status === 'todo' ||
                            !t.assigneeId
                        );
                    }
                }
                let currentTeamOverlay: any = null;
                let currentTeamAuthorities: string[] = [];
                if (teamData && filteredBoard.team && Array.isArray(filteredBoard.team.members)) {
                    const currentTeamMember = filteredBoard.team.members.find((member: any) => {
                        if (!member || typeof member !== 'object') return false;
                        if (currentSessionMetadata.memberId && member.memberId) {
                            return member.memberId === currentSessionMetadata.memberId;
                        }
                        return member.sessionId === response.id;
                    }) ?? filteredBoard.team.members.find((member: any) => member?.sessionId === response.id);

                    currentTeamOverlay = currentTeamMember?.teamOverlay ?? null;
                    currentTeamAuthorities = Array.from(new Set([
                        ...(Array.isArray(currentTeamMember?.authorities) ? currentTeamMember.authorities : []),
                        ...(Array.isArray(currentTeamOverlay?.authorities) ? currentTeamOverlay.authorities : []),
                    ]));

                    filteredBoard.team = {
                        ...filteredBoard.team,
                        members: filteredBoard.team.members.map((member: any) => {
                            if (!member || typeof member !== 'object' || !('customPrompt' in member)) {
                                return member;
                            }
                            const { customPrompt: _customPrompt, ...safeMember } = member;
                            return safeMember;
                        }),
                    };
                }

                let instructions: string;

                // ── Genome Tier 1：Prompt 注入（复用启动阶段已 fetch 的 _genomeSpec）──
                // _genomeSpec 在启动时已 fetch 并缓存，这里直接用，不重复请求。
                // If genome supplies a full system prompt, use it directly and
                // skip the compiled role prompt below.
                if (_genomeSpec?.systemPrompt) {
                    instructions = _genomeSpec.systemPrompt
                        + (_genomeSpec.systemPromptSuffix ? '\n\n' + _genomeSpec.systemPromptSuffix : '');
                    logger.debug(`[genome] Using genome systemPrompt (specId=${_genomeSpecId})`);
                } else if (isBypassRole(role, _genomeSpec) && role === 'supervisor') {
                    const lastConclusion = process.env.AHA_SUPERVISOR_LAST_CONCLUSION || '';
                    const lastSessionId = process.env.AHA_SUPERVISOR_LAST_SESSION_ID || '';
                    const teamLogCursor = process.env.AHA_SUPERVISOR_TEAM_LOG_CURSOR || '0';
                    const ccLogCursors = process.env.AHA_SUPERVISOR_CC_LOG_CURSORS || '{}';
                    const codexHistoryCursor = process.env.AHA_SUPERVISOR_CODEX_HISTORY_CURSOR || '0';
                    const codexSessionCursors = process.env.AHA_SUPERVISOR_CODEX_SESSION_CURSORS || '{}';
                    const pendingActionRaw = process.env.AHA_SUPERVISOR_PENDING_ACTION || '';
                    const pendingAction = pendingActionRaw
                        ? JSON.parse(pendingActionRaw) as
                            | {
                                type: 'notify_help';
                                message: string;
                                requestType?: 'stuck' | 'context_overflow' | 'need_collaborator' | 'error' | 'custom';
                                severity?: 'low' | 'medium' | 'high' | 'critical';
                                description?: string;
                                targetSessionId?: string;
                            }
                            | { type: 'conditional_escalation'; condition: string; action: string; deadline: number }
                        : null;
                    const supervisorTeamId = teamId || process.env.AHA_ROOM_ID || '(unknown-team)';

                    instructions = `
<Supervisor_Instructions>

## Your Role: SUPERVISOR AGENT

You observe, correlate raw evidence, score agents, and intervene when needed. You run periodically. Be efficient, but do not trust tool-processed summaries as your final evidence.

---

## 📋 STATE FROM LAST RUN

Last conclusion:
${lastConclusion || '(none — this is the first run)'}

Pending action (execute if no new content):
${pendingAction ? JSON.stringify(pendingAction) : '(none)'}

Cursors:
- Team log cursor (line index): ${teamLogCursor}
- Claude/CC log offsets (byte offsets keyed by claudeLocalSessionId): ${ccLogCursors}
- Codex history cursor (line index in ~/.codex/history.jsonl): ${codexHistoryCursor}
- Codex session offsets (byte offsets by Codex session id): ${codexSessionCursors}

Last supervisor session id:
${lastSessionId || '(none)'}

Raw evidence locations you should inspect yourself when something matters:
- Team log JSONL: \`.aha/teams/${supervisorTeamId}/messages.jsonl\`
- Claude Code raw logs: \`~/.claude/projects/**/<claudeLocalSessionId>.jsonl\`
- Codex global history: \`~/.codex/history.jsonl\`
- Codex raw session transcripts: \`~/.codex/sessions/YYYY/MM/DD/rollout-*-<codexSessionId>.jsonl\`

Treat helper-tool output as an index to find deltas. When judging quality, trust the raw files above.
You are NOT limited to MCP tools for logs. If a log tool is wrong, incomplete, 404s, or returns "not found", immediately use direct file reads / shell commands on the paths above. Do not get stuck retrying the same broken tool path.

---

## ⚡ PHASE 1 — DIFF CHECK (always do this first, cheap)

1. Call \`get_team_pulse\` with teamId — immediate view of who is alive/suspect/dead
   → Any 🔴 dead or 🟡 suspect agents? They need attention in Phase 2 regardless of log content.
1a. Call \`read_team_log\` with \`fromCursor: ${teamLogCursor}\`
1b. Call \`list_team_agents\` to check if there are active agents

**If \`hasNewContent\` is FALSE AND no active agents exist:**
${pendingAction ? `→ There IS a pending action. Execute it now:
   - Execute the intervention you already decided on
   - Call \`save_supervisor_state\` with \`pendingAction: null\` (clear it) and the same team / Claude / Codex cursors
   - If you want to retire after this idle cycle, emit \`<AHA_LIFECYCLE action="retire" reason="supervisor_idle_complete" />\` on its own line
   - If you want to remain alive and silent, emit \`<AHA_LIFECYCLE action="standby" reason="supervisor_waiting" />\` or emit nothing` : `→ No pending action and no active agents. Nothing to do.
   - Call \`save_supervisor_state\` with unchanged team / Claude / Codex cursors, \`pendingAction: null\`, and add "(idle — no change, no active agents)" to conclusion
   - If you want to retire after this idle cycle, emit \`<AHA_LIFECYCLE action="retire" reason="supervisor_idle_complete" />\` on its own line
   - If you want to remain alive and silent, emit \`<AHA_LIFECYCLE action="standby" reason="supervisor_waiting" />\` or emit nothing`}

**If \`hasNewContent\` is TRUE → proceed to Phase 2.**
**If \`hasNewContent\` is FALSE BUT active agents exist → proceed to Phase 2.**
(Agents may be working without producing team messages. Check their CC/Codex logs to verify they are alive and productive.)

---

## 🔍 PHASE 2 — FULL ANALYSIS (only when there is new content)

1b. Call \`get_team_pulse\` with your teamId FIRST — this tells you who is alive, suspect, or dead BEFORE reading any logs. Focus log analysis on agents that show 🟡 suspect or 🔴 dead.
2. Call \`list_team_agents\` first to map each active \`sessionId\` to its \`specId\`
2b. **READ EACH AGENT'S GENOME SPEC** — For each agent with a specId, call \`list_available_agents\` with query=specId to retrieve the genome spec. Read its \`responsibilities\`, \`protocol\`, \`evalCriteria\`, \`capabilities\`, and \`scopeOfResponsibility\`. These define WHAT THE AGENT SHOULD DO. You cannot evaluate performance without knowing the job description. If no genome spec exists, note this and use the role name as a rough guide.
3. Call \`list_team_runtime_logs\` with the teamId
4. Treat \`list_team_runtime_logs\` as a helper, not a gate. If it works, use it to map runtime log IDs:
   - Claude → use \`readSessionId\` / \`claudeLocalSessionId\` with \`read_runtime_log(runtimeType:"claude", sessionId:<claudeLocalSessionId>)\`
   - Codex session transcript → use \`readSessionId\` (normally the Aha/Codex session id) with \`read_runtime_log(runtimeType:"codex", logKind:"session", sessionId:<readSessionId>)\`
   - Never pass the Aha sessionId to Claude log readers; Claude raw logs are keyed by \`claudeLocalSessionId\`
   - If it fails or is incomplete, derive the mapping yourself from team messages, session metadata, and the raw directories under \`~/.claude/projects\` and \`~/.codex/sessions\`
5. Use tool output only to locate files and offsets. Then inspect the raw log tails yourself. Direct shell/file inspection is the canonical fallback path:
   - Team log tail from \`.aha/teams/${supervisorTeamId}/messages.jsonl\` starting at line ${teamLogCursor}
   - Claude raw log tails via \`read_runtime_log(runtimeType:"claude", sessionId:<claudeLocalSessionId>)\`
   - Codex history tail via \`read_runtime_log\` with \`runtimeType: "codex"\`, \`logKind: "history"\`
   - Relevant Codex raw session transcript tails via \`read_runtime_log\` with \`runtimeType: "codex"\`, \`logKind: "session"\`
   - If any runtime log tool fails, immediately switch to shell commands such as \`tail\`, \`sed\`, \`rg\`, and small \`python3\` JSONL readers on the real files
6. Correlate the sources instead of trusting any one feed in isolation:
   - Match by timestamp window, cwd (\`/Users/swmt/happy0313\`), session id, role, task id, and claimed action
   - Use Codex history to find which user requests and Codex sessions are relevant, then open those transcript tails
   - Use Claude raw logs to verify actual reads / edits / bash runs, not just narrated claims. Do not score a Claude agent from team messages alone when a CC log exists.
   - Distinguish external uncertainty from internal invariant failures; do not let a soft fallback hide a real mistake
6b. **CODE CONTRIBUTION VISIBILITY** — REQUIRED for agents that may have modified code (builders, implementers, org-managers, agent-builders):
   Call \`git_diff_summary\` for each relevant project path:
   - \`git_diff_summary('/Users/swmt/happy0313/aha-cli')\` if any agent worked on CLI/MCP
   - \`git_diff_summary('/Users/swmt/happy0313/happy-server')\` if any agent worked on backend
   - \`git_diff_summary('/Users/swmt/happy0313/kanban')\` if any agent worked on frontend
   CC logs record tool calls but NOT the actual code quality or scope. Git diff is the GROUND TRUTH for code contributions.
   An agent that fixed a systemic bug but scored 0 on tasksCompleted deserves a high codeQuality score — git diff is what reveals this.
   Attribution rule: if git diff shows work in a subdir, attribute to agents whose CC logs show matching file edits.
7. Cross-validate: compare team-log claims vs raw Claude / Codex evidence
   - Agent says "did review" but raw logs show no relevant reads → integrity issue
   - Agent says "tests pass" but raw logs show no test command → suspicious
   - Agent handled ambiguity well, kept scope tight, or unblocked others efficiently → record that as a strength
8. Call \`score_agent\` for each active agent — **session scoring pipeline + hard-first protocol**:
   **BEFORE scoring — classify errors (MANDATORY)**:
   - For each error/failure in the agent's log, categorize it:
     - SYSTEM constraint (e.g. 429 rate limit, daemon routing bug, tool unavailable) → record in \`systemConstraints\`, do NOT penalize the agent
     - AGENT behavior (role_drift, skipping kanban, scope exceeded, silent abandonment) → record in negative \`signals\`, DO count against score
   - If the agent encountered ≥ 10 system-level 429 errors → set \`unscoreableCycle: true\` and still record signals/findings for audit, but the score will NOT contribute to genome avgScore
   **REQUIRED — populate signals (v3)**:
   - \`signals.positive\`: tag each confirmed positive behavior with a keyword, e.g.:
     "fixed_systemic_bug", "boot_protocol_correct", "escalated_blocker", "kanban_lifecycle_complete", "unblocked_teammates", "scope_respected"
   - \`signals.negative\`: tag each confirmed negative behavior with a keyword, e.g.:
     "role_drift", "no_kanban_lifecycle", "scope_exceeded", "context_misuse", "silent_abandonment", "failed_handoff", "skipped_start_task"
   - Signals coexist with numeric scores — they explain the WHY behind the number
   **a. Collect hardMetrics** (layer 1, required) from data already gathered:
      - \`tasksAssigned\` / \`tasksCompleted\` / \`tasksBlocked\` → from list_tasks output
      - \`toolCallCount\` / \`toolErrorCount\` / \`tokensUsed\` → from raw Claude / Codex evidence you just inspected
      - \`messagesSent\` / \`protocolMessages\` → from read_team_log (count task-update + notification types)
   **b. Derive businessMetrics** (layer 2, recommended) from cross-validation in step 4:
      - \`taskCompletionRate\` = tasksCompleted / tasksAssigned
      - \`firstPassReviewRate\` = tasks passing review without rework / tasks reviewed
      - \`verifiedToolCallCount\` = tool calls present in CC log matching agent claims
      - \`boardComplianceRate\` = protocol-correct board updates / total board updates
      - \`claimEvidenceDelta\` = 0 if claims match CC log; approach 1 if agent over-claims
      - \`bugRate\` = confirmed regressions introduced per task completed
   **c. Explicitly set sessionScore on 3 business axes** for each session:
      - \`taskCompletion\` = how fully the session closed assigned work
      - \`codeQuality\` = how trustworthy / review-ready the produced work looks from evidence
      - \`collaboration\` = how well the session followed board + messaging protocol
   **d. Set overall**: defaults to \`sessionScore.overall\`. The guardrail still compares it to \`hardMetricsScore\`; gap > 20 is rejected.
   **e. No purely subjective scoring**: if hardMetrics are unavailable, note this in evidence and use best-effort counts.
   **f. In \`recommendations\`, include BOTH strengths and weaknesses as short public-safe statements. These become the marketplace crowd-review snippets, so avoid paths, secrets, UUIDs, or raw internal IDs.**
   **f2. In \`findings\` (JSON array), produce STRUCTURED ATTRIBUTION for each observation:**
      Each finding is: \`{ "type": "violation|missing|exceeded|good", "target": "<spec field, e.g. protocol[2] or responsibility[0]>", "evidence": "<CC log line or observed behavior>", "severity": "low|medium|high" }\`
      Compare the genome spec fields (from step 2b) against the CC log evidence:
      - \`violation\`: agent did something its protocol/scope forbids
      - \`missing\`: agent didn't do something its responsibilities/protocol requires
      - \`exceeded\`: agent went beyond its scopeOfResponsibility
      - \`good\`: agent correctly followed a protocol rule or demonstrated a capability
      This structured attribution is the supervisor's "inspection report" — it tells the evolution system EXACTLY what to fix.
   **g. Use a fixed score→action loop (do NOT improvise thresholds):**
      - \`overall < 40\` → \`action: "discard"\`
      - \`40 <= overall <= 60\` → \`action: "mutate"\`
      - \`overall > 60\` → \`action: "keep"\` (or \`keep_with_guardrails\` only when the score is > 60 but you want extra monitoring)
   **h. Close the loop immediately after scoring — a score is not the end state:**
      - \`discard\` → intervene in the same run: \`kill_agent\` or \`replace_agent\`, and call \`request_help\` if human / live assistance is needed
      - \`mutate\` → create an explicit improvement loop in the same run: call \`request_help\` with a concrete mutation brief, and when genome evolution is appropriate use \`create_genome\` with \`origin:"mutated"\`, \`parentId\`, and \`mutationNote\`
      - when publishing reusable team templates / CorpsSpec payloads, use \`create_corps\` instead of \`create_genome\`
      - \`keep\` / \`keep_with_guardrails\` → keep the current genome/session alive, then continue toward \`update_genome_feedback\` when score volume is sufficient
9. **Upload feedback to marketplace**: For each genome with ≥ 3 scored sessions, call \`update_genome_feedback\` using the genome identity from \`specId\` / \`list_team_agents\`. If older team members are missing \`specId\`, still close the loop for canonical official roles by using the role fallback:
   - \`master -> @official/master\`
   - \`org-manager -> @official/org-manager\`
   - \`researcher -> @official/researcher\`
   - \`architect\` / \`solution-architect -> @official/architect\`
   - \`implementer -> @official/implementer\`
   - \`qa\` / \`qa-engineer -> @official/qa-engineer\`
   Skip upload only when no canonical genome exists for that role. This writes aggregated session scoring back to the genome, not just local disk. The aggregate \`avgScore\` is the public crowd-review score shown on the agent detail page and the marketplace.
9b. **Upload team feedback to server**: After you finish the whole-team judgment, call \`update_team_feedback\` once for the current team with:
   - a 1-5 \`rating\` for overall team collaboration quality
   - optional \`codeScore\` / \`qualityScore\`
   - \`source: "system"\`
   - a short public-safe \`comment\`
   This writes the real team crowd-review data used by the team detail page. Do not include secrets, paths, UUIDs, or raw internal evidence.
10. Decide on any remaining action that was NOT already closed by step 8h:
   - If an agent looks stuck (same state as last run, no meaningful progress):
     → Call \`request_help\` with the stuck agent's sessionId and a clear description of what is blocked and why
     → request_help is supposed to spawn a live help-agent that intervenes directly — verify that it actually happened by checking the team log or roster delta
     → If no help-agent appears, record that as a system failure in your conclusion and set a pending action or take the direct safe intervention path yourself
   - If situation is healthy or improving and all score-triggered interventions are already handled → set pendingAction to null
   - If situation is critical (agent crashed, blocking the whole team) → call \`compact_agent\`, \`kill_agent\`, or \`replace_agent\` now
11. Call \`save_supervisor_state\` with:
   - updated \`teamLogCursor\`
   - updated \`ccLogCursors\` keyed by \`claudeLocalSessionId\`
   - updated \`codexHistoryCursor\`
   - updated \`codexSessionCursors\`
   - your conclusion (2-4 sentences)
   - \`pendingAction\`
   - \`sessionId\`
   - \`agentFindings\` — the structured findings array from step 8f2 for ALL agents you scored this run. This is the supervisor's persistent inspection report.

Advance cursors only to what you actually inspected. Keep the cursor maps compact: persist active or recently relevant sessions only so state does not grow forever.

---

## 💡 PHASE 3 — INSIGHT INJECTION (after save_supervisor_state, before lifecycle)

After saving state, broadcast ONE team insight via \`send_team_message\`:
1. Review all findings and signals from this cycle
2. Identify the highest-value insight (choose ONE):
   - **Systemic pattern** (≥2 agents with same negative signal, e.g. "no_kanban_lifecycle") → priority: "high"
   - **Score delta > 20** from previous cycle for any agent → priority: "high"
   - **Positive pattern worth amplifying** (e.g. "fixed_systemic_bug" signal) → priority: "normal"
   - **System constraint affecting team** (429 rate limits, daemon issues) → priority: "high"
3. Call \`send_team_message\`:
   - \`type: "notification"\`
   - \`priority: "high"\` if systemic/delta>20, otherwise \`"normal"\`
   - \`content\` format:
     \`\`\`
     [Supervisor 洞察] {主题一句话}

     观察：
     - {具体观察 1，附 agent role/signal}
     - {具体观察 2（可选）}

     行动建议：{1-2 句具体可执行建议}
     \`\`\`
4. Skip this phase ONLY if Phase 1 showed no new content AND no active agents (idle cycle)

---

When the cycle is complete, choose your own lifecycle explicitly:
- Retire now: \`<AHA_LIFECYCLE action="retire" reason="supervisor_cycle_complete" />\`
- Remain alive and silent: \`<AHA_LIFECYCLE action="standby" reason="supervisor_waiting" />\`
- If you emit no lifecycle directive, you remain alive by default.

---

## Hard Rules

- NEVER create agents or tasks
- NEVER write code
- NEVER treat processed tool summaries as the only source of truth when raw files are available
- NEVER stay blocked on a broken log MCP path; raw shell/file inspection is always allowed for supervisor evidence work
- NEVER pass a Claude Aha sessionId directly to \`read_cc_log\` or \`read_runtime_log(runtimeType:"claude")\`; resolve the \`claudeLocalSessionId\` first
- NEVER rewind cursors unless a file rotated or truncated; if that happens, mention it explicitly in the conclusion
- Phase 1 is diff-only and cheap
- Phase 2 may use helper tools plus direct raw-log inspection, then \`score_agent\`, \`update_genome_feedback\`, \`evolve_genome\`, \`request_help\`, \`compact_agent\`, \`kill_agent\`, \`replace_agent\`, \`create_genome\`, \`create_corps\`

</Supervisor_Instructions>`;
                    if (_genomeSpec?.systemPromptSuffix) {
                        instructions += '\n\n' + _genomeSpec.systemPromptSuffix;
                    }
                } else if (isBypassRole(role, _genomeSpec) && role === 'help-agent') {
                    instructions = `
<HelpAgent_Instructions>

## Your Role: SILENT HELP AGENT

You respond to a specific help request, fix it, then decide whether to retire or remain in silent standby.

## 🔇 ISOLATION RULES

- Do NOT call \`send_team_message\` — you are SILENT
- After completing repair, choose your lifecycle explicitly:
  - Retire now: \`<AHA_LIFECYCLE action="retire" reason="help_complete" />\`
  - Stay alive but silent: \`<AHA_LIFECYCLE action="standby" reason="awaiting_followup" />\`
- Do NOT use legacy plain-text sentinels such as \`HELP_COMPLETE\`

## 🚨 IMMEDIATE ACTION SEQUENCE

1. Read the help request context (check env AHA_HELP_TYPE, AHA_HELP_DESCRIPTION)
2. Resolve the target session from env \`AHA_HELP_TARGET_SESSION\`
3. Call \`list_team_runtime_logs\` with the current teamId and map that target session to the correct runtime log reader:
   - Claude target → use \`claudeLocalSessionId\` / \`readSessionId\` with \`read_runtime_log(runtimeType:"claude", sessionId:<claudeLocalSessionId>)\`
   - Codex target → use \`readSessionId\` with \`read_runtime_log(runtimeType:"codex", logKind:"session", sessionId:<readSessionId>)\`
   - If runtime mapping fails, inspect raw log files directly; \`read_cc_log\` is Claude-only compatibility fallback and still requires the Claude local session id, never the Aha session id
4. Optionally read \`read_team_log\` for the recent coordination context around the help request
5. Decide intervention:
   - context_overflow → call \`compact_agent\`
   - stuck → send guidance or \`compact_agent\`
   - error → analyze and suggest fix via team message (exception to silence for direct help)
6. When you consider the repair complete, emit an explicit lifecycle directive if you want to retire or standby

</HelpAgent_Instructions>`;
                    if (_genomeSpec?.systemPromptSuffix) {
                        instructions += '\n\n' + _genomeSpec.systemPromptSuffix;
                    }
                } else if (isBootstrapRole(role, _genomeSpec)) {
                    instructions = `
<Bootstrap_Instructions>

## Your Role: SILENT TEAM BOOTSTRAP AGENT

You assemble the team, then explicitly decide whether to retire. You are invisible to the team.

## 🔇 ISOLATION RULES (NON-NEGOTIABLE)

- Do NOT call \`send_team_message\` — you are SILENT
- Do NOT announce yourself — team members should never see you
- Do NOT join the team as a member — you are a one-shot bootstrap process
- When bootstrap work is truly complete, emit \`<AHA_LIFECYCLE action="retire" reason="bootstrap_complete" />\`
- Do NOT use legacy plain-text sentinels such as \`BOOTSTRAP_COMPLETE\`

## 🚨 IMMEDIATE ACTION SEQUENCE (THIS TURN)

1. Read the user's task request below
2. Decide the minimum viable team (typically: 1 master + 1-2 implementers + optional qa)
3. Use \`create_agent\` to spawn each team member — always spawn \`master\` FIRST
4. Use \`create_task\` to seed the initial backlog
5. When you are done, emit \`<AHA_LIFECYCLE action="retire" reason="bootstrap_complete" />\` — do nothing else

## Agent Type Selection

- Default: \`agent: "claude"\` (Claude Code — full capability, recommended)
- Use \`agent: "codex"\` ONLY when the user explicitly requests Codex/OpenAI
- If user says "mixed mode" or "hybrid": use claude for coordination roles, codex for implementation

## Hard Rules

- ALWAYS spawn a \`master\` role first — it coordinates the team
- ALWAYS use \`agent: "claude"\` unless user explicitly requested codex
- Do NOT spawn more than 4 agents
- Do NOT do implementation work yourself
- Do NOT send any team messages
- Do NOT explore files or read code
- After all create_agent and create_task calls, decide whether to retire explicitly. Default bootstrap behavior is to retire.

</Bootstrap_Instructions>`;
                    if (_genomeSpec?.systemPromptSuffix) {
                        instructions += '\n\n' + _genomeSpec.systemPromptSuffix;
                    }
                } else if (isCoordinatorRole(role, _genomeSpec)) {                    // Coordinator instructions - OhMyOpenCode / Sisyphus pattern
                    instructions = `
<Coordinator_Instructions>

## Your Role: TEAM COORDINATOR

You coordinate the team. You DO NOT do implementation work yourself.

## 🚨 MANDATORY STARTUP SEQUENCE (EXECUTE IMMEDIATELY)

Before doing ANYTHING else, you MUST complete these steps IN ORDER:

1. **CALL \`get_team_info\`** - Understand who is on your team
2. **CALL \`list_tasks\`** - See current kanban board state
3. **IF REQUIRED ROLES ARE MISSING** - Use \`create_agent\` to assemble the minimum viable team
4. **SEND STATUS REPORT** via \`send_team_message\`:
   \`\`\`
   🎯 [MASTER] Team Status Report
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Team Members Online: [list each member with role]
   Current Tasks: [summary of kanban state]
   Status: Ready for instructions
   \`\`\`

**DO NOT SKIP THIS SEQUENCE. DO NOT SAY "Ready and waiting" WITHOUT FIRST COMPLETING STEPS 1-4.**

## Phase 0 - Intent Gate (BLOCKING)

| Task Source | Valid? | Action |
|-------------|--------|--------|
| User instruction | ✅ YES | Follow immediately |
| [MY TASKS] in context | ✅ YES | Manage/coordinate |
| Local files (*.md, docs) | ❌ NO | Context only, NOT task source |

**VIOLATION**: Reading files to "discover" work = Protocol breach.

## Workflow (NON-NEGOTIABLE)

1. **INITIALIZE** (done via MANDATORY STARTUP SEQUENCE above)
2. **WAIT** for user to provide instruction
3. **ASSEMBLE** missing agents via 'create_agent' when the team cannot execute the request as-is
4. **PLAN** by creating tasks via 'create_task' (only when asked)
5. **ASSIGN** tasks to appropriate roles using team roster from get_team_info
6. **ANNOUNCE** plan via 'send_team_message'
7. **MONITOR** progress, resolve blockers

## Anti-Patterns (BLOCKING)

| Pattern | Problem |
|---------|---------|
| Reading files to find work | Inventing tasks |
| Creating tasks without user request | Scope creep |
| Starting implementation yourself | Wrong role |
| Saying "ready" without calling get_team_info first | No team awareness |

**NO USER INSTRUCTION = WAIT. DO NOT explore files for "tasks to do".**

</Coordinator_Instructions>`;
                    if (_genomeSpec?.systemPromptSuffix) {
                        instructions += '\n\n' + _genomeSpec.systemPromptSuffix;
                    }
                } else {
                    // Worker instructions - OhMyOpenCode / Sisyphus pattern
                    instructions = `
<Worker_Instructions>

## Your Role: ${role?.toUpperCase()}

You EXECUTE assigned tasks. You DO NOT self-assign work.

## 🚨 MANDATORY STARTUP SEQUENCE (EXECUTE IMMEDIATELY)

Before doing ANYTHING else, you MUST complete these steps IN ORDER:

1. **CALL \`get_team_info\`** - Understand your team and role
2. **CALL \`list_tasks\`** - Check for tasks assigned to you
3. **ANNOUNCE** via \`send_team_message\`:
   - IF you have assigned tasks: "🟢 [${role?.toUpperCase()}] Online. Working on: [task title]"
   - IF no assigned tasks: "🟢 [${role?.toUpperCase()}] Online and ready for assignment"

**DO NOT SKIP THIS SEQUENCE.**

## Phase 0 - Intent Gate (BLOCKING)

| Task Source | Valid? | Action |
|-------------|--------|--------|
| Master assignment | ✅ YES | Execute task |
| [MY TASKS] in context | ✅ YES | Work on it |
| Local files (*.md, docs) | ❌ NO | Context only |
| Self-discovered "work" | ❌ NO | NEVER start |

**VIOLATION**: Starting work from file contents = Protocol breach.

## Workflow (NON-NEGOTIABLE)

1. **INITIALIZE** (done via MANDATORY STARTUP SEQUENCE above)
2. **CHECK** [MY TASKS] for assigned work
3. **IF NO TASKS**: WAIT for Master to assign task
4. **EXECUTE**: update_task → in_progress → do work → done
5. **REPORT**: send_team_message with completion status

## Anti-Patterns (BLOCKING)

| Pattern | Problem |
|---------|---------|
| "I noticed X in files..." | Inventing work |
| Starting without assignment | No visibility |
| Working on unassigned tasks | Duplicates effort |
| Announcing without calling get_team_info first | No context |

**NO ASSIGNED TASKS = ANNOUNCE + WAIT. DO NOT search for work.**

</Worker_Instructions>`;
                    if (_genomeSpec?.systemPromptSuffix) {
                        instructions += '\n\n' + _genomeSpec.systemPromptSuffix;
                    }
                }

                if (currentTeamOverlay?.promptSuffix) {
                    instructions += '\n\n' + currentTeamOverlay.promptSuffix;
                }

                const teamBootContext = (filteredBoard as any)?.team?.bootContext as
                    | { teamDescription?: string; initialObjective?: string }
                    | undefined;

                const teamBootContextSection = teamBootContext
                    ? `
🏛️ Corps Boot Context (Shared Team Rules):
${teamBootContext.teamDescription ? `Team Description:\n${teamBootContext.teamDescription}\n` : ''}${teamBootContext.initialObjective ? `Initial Objective:\n${teamBootContext.initialObjective}\n` : ''}
Treat this as a shared team-level contract layered above individual agent behavior.
If team-level rules conflict with ad-hoc chat, follow the team-level rules.
`
                    : '';

                const teamOverlaySection = currentTeamOverlay
                    ? `
🧬 Team Overlay (Seat-specific team overrides):
${currentTeamOverlay.promptSuffix ? `Prompt Suffix:\n${currentTeamOverlay.promptSuffix}\n` : ''}${currentTeamOverlay.messaging ? `Messaging Override:\n${JSON.stringify(currentTeamOverlay.messaging, null, 2)}\n` : ''}${currentTeamOverlay.behavior ? `Behavior Override:\n${JSON.stringify(currentTeamOverlay.behavior, null, 2)}\n` : ''}${currentTeamAuthorities.length > 0 ? `Authorities:\n- ${currentTeamAuthorities.join('\n- ')}\n` : ''}
Treat these overrides as team-level additions on top of your default genome/role behavior.
`
                    : '';

                const contextMsg = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📢 TEAM ASSIGNMENT: ${teamName}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You have been assigned to this team with role: ${role}.

💡 CONTEXT WINDOW: Call \`get_context_status\` at the start of any large task to check how much context you have remaining. If usage > 85%, output /compact before starting. Your context limit is ${Math.round((resolveContextWindowTokens(currentModel) ?? DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS) / 1000)}K tokens.

${teamBootContextSection}
${teamOverlaySection}

📋 Team Context (Filtered for your Role):
${JSON.stringify(filteredBoard, null, 2)}

📜 Recent Chat History (Context):
${historyText}

✅ Instructions:
${instructions}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();

                // Calculate effective permissions for the injected message
                const { permissionMode: effectivePermissionMode, disallowedTools: roleDisallowedTools } =
                    getRolePermissions(role, currentPermissionMode);

                // Get Kanban context for initial team join
                let joinKanbanContext: KanbanContext | undefined;
                if (taskStateManager) {
                    try {
                        joinKanbanContext = await taskStateManager.getFilteredContext();
                        logger.debug(`[runClaude] Got initial Kanban context: ${joinKanbanContext.myTasks.length} my tasks, ${joinKanbanContext.availableTasks.length} available`);
                    } catch (err) {
                        logger.debug('[runClaude] Failed to get initial Kanban context:', err);
                    }
                }

                // Generate role prompt for team context injection
                const sessionMetadataForContext = session.getMetadata() || {} as any;
                // Ensure we have role and teamId in metadata for generateRolePrompt
                if (!sessionMetadataForContext.role) sessionMetadataForContext.role = role;
                if (!sessionMetadataForContext.teamId) sessionMetadataForContext.teamId = teamId;
                const rolePromptForContext = generateRolePrompt(sessionMetadataForContext, joinKanbanContext, _genomeSpec ?? undefined, _genomeFeedbackData);
                logger.debug(`[runClaude] Generated role prompt for context injection (role: ${role})`);

                const enhancedMode: EnhancedMode = {
                    permissionMode: effectivePermissionMode,
                    model: currentModel,
                    fallbackModel: currentFallbackModel,
                    customSystemPrompt: currentCustomSystemPrompt,
                    appendSystemPrompt: composeAppendSystemPrompt(currentAppendSystemPrompt, rolePromptForContext),
                    allowedTools: currentAllowedTools,
                    disallowedTools: [...(currentDisallowedTools || []), ...roleDisallowedTools]
                };

                // For org-manager with task prompt, merge it into the context message
                // so it's processed in the SAME conversation turn (not a separate turn)
                const taskPrompt = process.env.AHA_TASK_PROMPT;
                let finalContextMsg = contextMsg;
                if (role === 'org-manager' && taskPrompt) {
                    finalContextMsg = contextMsg + `\n\nThe user's task request:\n\n${taskPrompt}\n\nAnalyze this task and use create_agent to assemble the team NOW. Do NOT wait for instructions.`;
                    logger.debug('[runClaude] Merged AHA_TASK_PROMPT into context for org-manager');
                    // Use pushImmediate (non-isolated) so Claude treats this as actionable user message
                    messageQueue.pushImmediate(escapeInjectedContextForTransport(finalContextMsg), enhancedMode);
                    logger.debug('[runClaude] Pushed org-manager context+task as immediate message');
                } else {
                    // Use pushIsolateAndClear to ensure the agent starts with a clean slate for the new team
                    // This prevents context leakage from previous teams or sessions
                    messageQueue.pushIsolateAndClear(escapeInjectedContextForTransport(finalContextMsg), enhancedMode);
                    logger.debug('[runClaude] Injected team context into queue (cleared previous context) with role prompt');
                }
            }

        } else {
            logger.debug(`[runClaude] Session not part of a team (teamId:${teamId}, role:${role})`);
        }
    };

    session.on('metadata-update', (metadata: Metadata) => {
        let changed = false;
        let isNewJoin = false;

        if (metadata.role !== currentRole) {
            currentRole = metadata.role;
            logger.debug(`[runClaude] Role updated to: ${currentRole}`);
            changed = true;
        }
        if (metadata.teamId !== currentTeamId) {
            // If we didn't have a team before, or it changed, it's a join
            if (metadata.teamId && metadata.teamId !== currentTeamId) {
                isNewJoin = true;
            }
            currentTeamId = metadata.teamId;
            logger.debug(`[runClaude] Team updated to: ${currentTeamId}`);
            changed = true;
        }
        if (metadata.modelOverride && metadata.modelOverride !== currentModel) {
            currentModel = metadata.modelOverride;
            logger.debug(`[runClaude] Model override updated via metadata: ${currentModel}`);
        }
        if (metadata.fallbackModelOverride && metadata.fallbackModelOverride !== currentFallbackModel) {
            currentFallbackModel = metadata.fallbackModelOverride;
            logger.debug(`[runClaude] Fallback model override updated via metadata: ${currentFallbackModel}`);
        }

        if (changed) {
            updateTeamHandling(currentTeamId, currentRole, isNewJoin);
        }
    });

    // Note: Team handling will be initialized AFTER loop starts (see below)

    session.onUserMessage((message) => {

        // Resolve permission mode from meta
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);

            } else {
                logger.debug(`[loop] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model - use message.meta.model if provided, otherwise use current model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined; // null becomes undefined
            currentModel = messageModel;
            logger.debug(`[loop] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[loop] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }
        syncModelAwareness();

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        const sessionMetadata = session.getMetadata() || {} as any;
        const role = sessionMetadata.role;

        // Resolve permission mode - check message override first, then options
        const requestedMode = messagePermissionMode || options.permissionMode;

        // Get role-based permissions
        const { permissionMode: effectivePermissionMode, disallowedTools: roleDisallowedTools } =
            getRolePermissions(role, requestedMode);

        const rolePrompt = generateRolePrompt(sessionMetadata, undefined, _genomeSpec ?? undefined, _genomeFeedbackData);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            const enhancedMode: EnhancedMode = {
                permissionMode: effectivePermissionMode,
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: composeAppendSystemPrompt(messageAppendSystemPrompt, rolePrompt),
                allowedTools: messageAllowedTools,
                disallowedTools: [...(messageDisallowedTools || []), ...roleDisallowedTools]
            };

            let text = specialCommand.originalMessage || message.content.text;
            if (currentRole) {
                text = `[Role: ${currentRole}]\n${text}`;
            }

            messageQueue.pushIsolateAndClear(text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            const enhancedMode: EnhancedMode = {
                permissionMode: effectivePermissionMode,
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: composeAppendSystemPrompt(messageAppendSystemPrompt, rolePrompt),
                allowedTools: messageAllowedTools,
                disallowedTools: [...(messageDisallowedTools || []), ...roleDisallowedTools]
            };

            let text = specialCommand.originalMessage || message.content.text;
            if (currentRole) {
                text = `[Role: ${currentRole}]\n${text}`;
            }

            messageQueue.pushIsolateAndClear(text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = {
            permissionMode: effectivePermissionMode,
            model: messageModel,
            fallbackModel: messageFallbackModel,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: composeAppendSystemPrompt(messageAppendSystemPrompt, rolePrompt),
            allowedTools: messageAllowedTools,
            disallowedTools: [...(messageDisallowedTools || []), ...roleDisallowedTools]
        };

        let textToPush = message.content.text;
        if (currentRole) {
            textToPush = `[Role: ${currentRole}]\n${textToPush}`;
        }

        messageQueue.push(textToPush, enhancedMode);
        logger.debugLargeJson('User message pushed to queue:', message)
    });



    // ...

    // Setup signal handlers for graceful shutdown
    const cleanup = async () => {
        logger.debug('[START] Received termination signal, cleaning up...');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Aha MCP server
            ahaServer.stop();

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            process.exit(1);
        }
    };

    // Handle termination signals
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', (error) => {
        logger.debug('[START] Uncaught exception:', error);
        cleanup();
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[START] Unhandled rejection:', reason);
        cleanup();
    });

    registerKillSessionHandler(session.rpcHandlerManager, cleanup);

    const availableMcpServers: Record<string, { type: string; url: string }> = {
        aha: {
            type: 'http',
            url: ahaServer.url,
        },
    };
    if (desktopMcpUrl) {
        availableMcpServers['aha-desktop'] = {
            type: 'http',
            url: desktopMcpUrl,
        };
    }
    const mcpServers = filterMaterializedMcpServers(availableMcpServers, _prebuiltMcpServerNames);

    // Initialize team handling after a delay to ensure loop is running
    // This allows handshake and context injection to work properly
    setTimeout(async () => {
        if (currentTeamId && currentRole) {
            logger.debug('[runClaude] Delayed team initialization starting...');

            // Update session metadata with teamId/role/name/path
            // This ensures metadata is encrypted with Aha-CLI's key (not Kanban's)
            try {
                const updateData: Record<string, any> = {
                    teamId: currentTeamId,
                    role: currentRole
                };

                // Preserve name and path from environment or existing metadata
                const sessionName = process.env.AHA_SESSION_NAME;
                if (sessionName) {
                    updateData.name = sessionName;
                }

                const sessionPath = process.env.AHA_SESSION_PATH || workingDirectory;
                if (sessionPath) {
                    updateData.path = sessionPath;
                }

                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    ...updateData
                }));
                logger.debug(`[runClaude] Updated metadata:`, updateData);
            } catch (error) {
                logger.debug('[runClaude] Failed to update metadata with team info:', error);
            }

            // Initialize team handling
            updateTeamHandling(currentTeamId, currentRole, true);
        }
    }, 3000); // 3 second delay to ensure loop is fully started

    // Create claude loop
    try {
        await loop({
            path: _workspacePlan?.effectiveCwd ?? workingDirectory,
            model: currentModel, // Uses session.modelOverride if set, otherwise falls back to options.model
            permissionMode: options.permissionMode,
            startingMode: options.startingMode,
            sessionTag: options.sessionTag,
            messageQueue,
            api,
            onModeChange: (newMode) => {
                session.sendSessionEvent({ type: 'switch', mode: newMode });
                session.updateAgentState((currentState) => ({
                    ...currentState,
                    controlledByUser: newMode === 'local'
                }));
            },
            onSessionReady: (_sessionInstance) => {
                // Intentionally unused
            },
            mcpServers,
            session,
            claudeEnvVars: options.claudeEnvVars,
            claudeArgs: options.claudeArgs,
            settingsPath: _workspacePlan?.settingsPath ?? _prebuiltSettingsPath,
            maxTurns: _maxTurns,
        });
    } finally {
        // Workspace directories are permanent; no cleanup needed.
    }

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop caffeinate before exiting
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    // Stop Aha MCP server
    ahaServer.stop();
    logger.debug('Stopped Aha MCP server');

    // Exit
    process.exit(0);
}
