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
import { completeRunEnvelope } from '@/daemon/runEnvelope';
import { initialMachineMetadata } from '@/daemon/run';
import { startAhaServer } from '@/claude/utils/startAhaServer';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { resolve } from 'node:path';
import {
    buildAgentHandshakeContent,
    canSpawnAgents,
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
import { fetchAgentImage, fetchAgentVerdictData } from './utils/fetchGenome';
import { createHotEvolutionTick } from './utils/hotEvolutionTick';
import { buildAgentWorkspacePlanFromAgentImage, MaterializeAgentWorkspaceResult, withDefaultAgentSkills } from '@/agentDocker/materializer';
import { filterMaterializedMcpServers, readMaterializedMcpServerNames } from '@/agentDocker/runtimeConfig';
import { getInjectedAllowedToolsForAgentImage } from '@/utils/genomePublication';
import { buildRuntimeBuildMetadata } from '@/utils/runtimeBuild';
import { ensureCurrentSessionRegisteredToTeam } from './team/ensureTeamMembership';
import { buildModelSelfAwarenessPrompt, resolveContextWindowTokens, DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS } from '@/utils/modelContextWindows';
import { resolveInitialModelOverrides } from './utils/modelOverrides';
import { buildMountedAgentPrompt } from '@/utils/buildMountedAgentPrompt';
import { sanitizeFallbackModel } from './utils/sanitizeFallbackModel';
import { computeEffectiveAllowedToolsFromMetadata, hasDynamicGrantOptIn } from './utils/temporaryToolGrants';
import { buildSessionScopeFilters } from './team/sessionScope';

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

function serializeErrorForLog(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        const base: Record<string, unknown> = {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };

        const anyError = error as Error & { code?: unknown; cause?: unknown };
        if (anyError.code !== undefined) {
            base.code = anyError.code;
        }
        if (anyError.cause !== undefined) {
            base.cause = anyError.cause instanceof Error
                ? {
                    name: anyError.cause.name,
                    message: anyError.cause.message,
                    stack: anyError.cause.stack,
                }
                : anyError.cause;
        }
        return base;
    }

    if (error && typeof error === 'object') {
        return error as Record<string, unknown>;
    }

    return { value: String(error) };
}

/**
 * Replace `{{VAR_NAME}}` placeholders in a genome systemPrompt with runtime values.
 * Unknown tokens are left as-is so downstream code can still detect them.
 */
function resolvePromptTemplateVars(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}

/**
 * Build a stringified pending-action block from the env var.
 * Returns '(none)' when the env var is empty / missing.
 */
function buildPendingActionBlock(): string {
    const raw = process.env.AHA_SUPERVISOR_PENDING_ACTION || '';
    if (!raw) return '(none)';
    try {
        const parsed = JSON.parse(raw);
        return JSON.stringify(parsed);
    } catch {
        return raw;
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

    const processStartedAt = Date.now();
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
        processStartedAt,
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        sessionTag,
        runtimeBuild: buildRuntimeBuildMetadata({
            cwd: workingDirectory,
            runtime: 'claude',
            startedAt: processStartedAt,
        }),
    };
    if (process.env.AHA_TEAM_MEMBER_ID) {
        metadata.memberId = process.env.AHA_TEAM_MEMBER_ID;
    }
    if (process.env.AHA_AGENT_ROLE) {
        metadata.role = process.env.AHA_AGENT_ROLE;
        logger.debug(`[runClaude] Setting metadata.role from env: ${process.env.AHA_AGENT_ROLE}`);
    }
    if (process.env.AHA_CANDIDATE_ID) {
        metadata.candidateId = process.env.AHA_CANDIDATE_ID;
        logger.debug(`[runClaude] Setting metadata.candidateId from env: ${process.env.AHA_CANDIDATE_ID}`);
    }
    if (process.env.AHA_SPEC_ID) {
        metadata.specId = process.env.AHA_SPEC_ID;
    }
    if (process.env.AHA_CANDIDATE_IDENTITY_JSON) {
        try {
            metadata.candidateIdentity = JSON.parse(process.env.AHA_CANDIDATE_IDENTITY_JSON);
        } catch {
            // Non-fatal: candidateId remains the compatibility field.
        }
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

    // Create message queue for managing state updates
    const messageQueue = new MessageQueue2<EnhancedMode>(
        (mode) => hashObject(mode)
    );

    // Start Aha MCP server — pass a ref so genome spec (loaded below) can be written in later
    const _agentImageRef: { current: import('../api/types/genome').AgentImage | null | undefined } = { current: undefined };
    const ahaServer = await startAhaServer(api, session, _agentImageRef);
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

    let currentLoopMode: 'local' | 'remote' = options.startingMode ?? 'local';
    session.keepAlive(false, currentLoopMode);
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(false, currentLoopMode);
    }, 2000);

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

    const sanitizeCurrentFallbackModel = (source: string) => {
        const nextFallbackModel = sanitizeFallbackModel(currentModel, currentFallbackModel);
        if (nextFallbackModel !== currentFallbackModel) {
            logger.debug(
                `[runClaude] Clearing fallback model from ${source} because it matches primary model: ${currentModel}`,
            );
            currentFallbackModel = nextFallbackModel;
        }
    };

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
    let currentAllowedTools: string[] | undefined = undefined; // Effective allowed tools (baseline ⊕ temporal grants)
    let currentDisallowedTools: string[] | undefined = undefined; // Effective disallowed tools
    let baselineAllowedTools: string[] | undefined = undefined; // Static/session override allowlist before grants
    let baselineDisallowedTools: string[] | undefined = undefined; // Static/session override denylist before grants
    let allowDynamicToolGrants = false;
    let lastRuntimePermissionSignature: string | null = null;
    let lastEffectiveToolAccessSignature: string | null = null;

    const syncRuntimePermissionMetadata = () => {
        const signature = JSON.stringify({
            permissionMode: currentPermissionMode ?? null,
            allowedTools: currentAllowedTools ?? null,
            disallowedTools: currentDisallowedTools ?? null,
        });
        if (signature === lastRuntimePermissionSignature) {
            return;
        }
        lastRuntimePermissionSignature = signature;
        void session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            runtimePermissions: {
                source: 'claude-runtime',
                updatedAt: Date.now(),
                permissionMode: currentPermissionMode ?? null,
                allowedTools: currentAllowedTools ?? null,
                disallowedTools: currentDisallowedTools ?? null,
            },
        })).catch((error) => {
            logger.debug('[runClaude] Failed to sync runtime permission metadata:', error);
        });
    };

    const recomputeEffectiveRuntimeToolAccess = (metadataOverride?: Metadata | null, reason: string = 'runtime-refresh') => {
        const metadataForComputation = metadataOverride ?? session.getMetadata();
        const computed = computeEffectiveAllowedToolsFromMetadata({
            baseAllowedTools: baselineAllowedTools,
            baseDisallowedTools: baselineDisallowedTools,
            metadata: allowDynamicToolGrants ? metadataForComputation : null,
            dynamicGrantOptIn: allowDynamicToolGrants,
        });

        currentAllowedTools = computed.allowedTools;
        currentDisallowedTools = computed.disallowedTools;

        const signature = JSON.stringify({
            allowedTools: currentAllowedTools ?? null,
            disallowedTools: currentDisallowedTools ?? null,
            activeGrantTools: computed.activeGrantTools,
        });
        if (signature !== lastEffectiveToolAccessSignature) {
            lastEffectiveToolAccessSignature = signature;
            logger.debug(
                `[runClaude] Effective tool access recomputed (${reason}): allow=${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'} deny=${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'} grants=${computed.activeGrantTools.join(', ') || 'none'}`,
            );
        }
    };

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
    const _agentImageId = _explicitSpecId ?? _roleBasedSpecId;
    const [_agentImage, _agentVerdictData] = _agentImageId
        ? await Promise.all([
            fetchAgentImage(credentials.token, _agentImageId).catch((err) => {
                // AHA_GENOME_FALLBACK=1 → silent (production mode)
                // default (testing) → warn so we can see genome loading failures
                if (process.env.AHA_GENOME_FALLBACK !== '1') {
                    console.warn(`[GENOME] ⚠️  Failed to load genome spec (specId=${_agentImageId}): ${err?.message ?? err}`);
                    console.warn(`[GENOME]    Running without genome DNA. Fix genome-hub or set AHA_GENOME_FALLBACK=1 to silence.`);
                }
                return null;
            }),
            fetchAgentVerdictData(credentials.token, _agentImageId).catch(() => null),
        ])
        : [null, null] as const;

    // Write into the ref so startAhaServer's tools (create_agent etc.) can use genome data
    _agentImageRef.current = _agentImage;
    const startupRole = process.env.AHA_AGENT_ROLE || session.getMetadata()?.role;
    allowDynamicToolGrants = hasDynamicGrantOptIn(_agentImage);

    if (_agentImage) {
        // Tier 2 — 模型覆盖
        if (_agentImage.modelId && !currentModel) {
            currentModel = _agentImage.modelId;
            logger.debug(`[genome] Model set from genome: ${currentModel}`);
        }
        if (_agentImage.fallbackModelId && !currentFallbackModel) {
            currentFallbackModel = _agentImage.fallbackModelId;
            logger.debug(`[genome] Fallback model set from genome: ${currentFallbackModel}`);
        }
        sanitizeCurrentFallbackModel('genome');

        // Tier 3 — 工具访问控制
        // Core team tools that EVERY agent must have — kanban, messaging, help.
        // Without these, agents become isolated islands that can't collaborate.
        const ignoreGenomeToolConstraints = isBypassRole(startupRole, _agentImage) && startupRole === 'supervisor';
        if (_agentImage.allowedTools?.length) {
            if (ignoreGenomeToolConstraints) {
                logger.debug('[genome] Ignoring genome allowedTools for supervisor so it can inspect raw logs directly');
            } else {
                // Merge mandatory team tools into the genome's allowedTools whitelist
                // so agents never lose kanban/messaging/help, and spawn-capable genomes
                // keep create_agent/list_available_agents available.
                const merged = Array.from(new Set([
                    ...getInjectedAllowedToolsForAgentImage(_agentImage, {
                        spawnCapable: canSpawnAgents(startupRole, _agentImage),
                    }),
                    ..._agentImage.allowedTools,
                ]));
                baselineAllowedTools = merged;
                logger.debug(`[agent-image] Allowed tools set from agent image (${_agentImage.allowedTools.length} custom + injected team tools = ${merged.length} total)`);
            }
        }
        if (_agentImage.disallowedTools?.length) {
            if (ignoreGenomeToolConstraints) {
                logger.debug('[genome] Ignoring genome disallowedTools for supervisor so it can inspect raw logs directly');
            } else {
                baselineDisallowedTools = _agentImage.disallowedTools;
                logger.debug(`[genome] Disallowed tools set from genome: ${baselineDisallowedTools.join(', ')}`);
            }
        }

        // Always block Claude Code's BUILT-IN team tools — our agents use Aha MCP team tools instead.
        // Without this, agents confuse SendMessage (CC native) with send_team_message (Aha MCP),
        // causing "Not in a team context" errors.
        const CC_NATIVE_TEAM_TOOLS = ['SendMessage', 'TeamCreate', 'TeamDelete'];
        baselineDisallowedTools = [...(baselineDisallowedTools || []), ...CC_NATIVE_TEAM_TOOLS];

        // Tier 4 — 权限模式（优先级低于 CLI 参数）
        if (_agentImage.permissionMode && !currentPermissionMode) {
            currentPermissionMode = _agentImage.permissionMode;
            logger.debug(`[genome] Permission mode set from genome: ${currentPermissionMode}`);
        }

        logger.debug(`[genome] Genome spec applied at startup (specId=${_agentImageId})`);
    }
    recomputeEffectiveRuntimeToolAccess(session.getMetadata(), 'startup');

    // ── Hot Evolution：background genome version poll ─────────────────────────
    // Poll genome-hub every AHA_HOT_EVOLUTION_INTERVAL_MS ms (default 5 min).
    // If entity.version has increased, update _agentImageRef.current so the
    // NEXT message turn picks up the evolved systemPrompt without a restart.
    // Startup-time config (tools, model, permissions) is intentionally NOT
    // hot-swapped — only systemPrompt + systemPromptSuffix (narrative behavior).
    let _hotEvolutionInterval: ReturnType<typeof setInterval> | undefined;
    if (_agentImageId) {
        let _hotEvolutionKnownVersion = _agentImage?.version ?? 0;
        const _hotEvolutionIntervalMs =
            Number(process.env.AHA_HOT_EVOLUTION_INTERVAL_MS || '') || 6 * 60 * 1000;
        const _hotEvolutionTick = createHotEvolutionTick({
            token: credentials.token,
            specId: _agentImageId,
            agentImageRef: _agentImageRef,
            initialVersion: _hotEvolutionKnownVersion,
            fetchFn: fetchAgentImage,
            onVersionBump: (latest) => {
                allowDynamicToolGrants = hasDynamicGrantOptIn(latest);
            },
        });
        _hotEvolutionInterval = setInterval(_hotEvolutionTick, _hotEvolutionIntervalMs);
    }
    // ─────────────────────────────────────────────────────────────────────────
    syncRuntimePermissionMetadata();
    // ─────────────────────────────────────────────────────────────────────────

    // ── Genome Tier 8–9：Hooks + Skills + maxTurns + env 注入 ───────────────
    // 将 genome/launch config 的 hooks/env 物化为 .aha/runtime/<agentId>/workspace/.claude/ 下的持久文件，
    // skills 注入 appendSystemPrompt；settingsPath 传递给 launcher 的 --settings 标志。
    const _agentId = process.env.AHA_TEAM_MEMBER_ID || response.id;
    let _workspacePlan: MaterializeAgentWorkspaceResult | null = null;
    let _maxTurns: number | undefined = _agentImage?.maxTurns;

    if (_agentImage) {
        // Materialize workspace (hooks → settings.json, env → env.json, skills → commands/)
        try {
            _workspacePlan = buildAgentWorkspacePlanFromAgentImage(_agentImage, {
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
            logger.error('[genome] Failed to materialize workspace:', serializeErrorForLog(err));
            throw err;
        }

        // Skills → system prompt injection (agent awareness)
        const effectiveSkills = withDefaultAgentSkills(_agentImage.skills);
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
    const _prebuiltSettingsPath = (!_agentImage && process.env.AHA_SETTINGS_PATH)
        ? process.env.AHA_SETTINGS_PATH
        : undefined;
    const _prebuiltMcpServerNames = (!_agentImage && process.env.AHA_AGENT_MCP_CONFIG_PATH)
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
            genomeModelId: _agentImage?.modelId,
            genomeModelProvider: _agentImage?.modelProvider,
        });

        if (resolved.isSupported) {
            currentModel = resolved.modelId;
            logger.debug(`[modelRouter] Resolved model: ${resolved.provider}/${resolved.modelId} (role=${roleForRouter}, plane=${execPlane})`);
        } else {
            // 非 Anthropic provider 降级：记录警告，使用 fallback model
            logger.debug(
                `[modelRouter] Provider not supported, falling back to anthropic/${resolved.fallbackModelId}. ` +
                `(genome requested: ${_agentImage?.modelProvider}/${_agentImage?.modelId})`
            );
            currentModel = resolved.fallbackModelId;
            if (!currentFallbackModel) {
                currentFallbackModel = resolved.fallbackModelId;
            }
        }
    }
    sanitizeCurrentFallbackModel('startup');
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
            taskStateManager = new TaskStateManager(api, teamId, response.id, role, session.getMetadata() || metadata);

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
                specId: _agentImageId || undefined,
            });
            logger.debug(
                `[runClaude] Team membership sync result: registered=${membershipResult.registered}, alreadyPresent=${membershipResult.alreadyPresent}`
            );

            // Initialize ApprovalWorkflow for coordination roles (master, orchestrator, team-lead)
            if (isCoordinatorRole(role, _agentImage)) {
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
                    const remoteHistory = await api.getTeamMessages(teamId, {
                        limit: 200,
                        ...buildSessionScopeFilters(session.getMetadata() || metadata),
                    });
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
                        const rolePromptForTeamMsg = generateRolePrompt(sessionMetadataForTeamMsg, kanbanContext, _agentImage ?? undefined, _agentVerdictData);
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

                // 1. Send Handshake - Dynamic from AgentImage + explicit role context + @help
                try {
                    const roleDef = DEFAULT_ROLES[role!];
                    const roleTitle = _agentImage?.displayName || roleDef?.name || role;

                    // Dynamic: pull responsibilities and capabilities from AgentImage (the DNA),
                    // fall back to static role definitions only when no genome is loaded.
                    const responsibilities: string[] = _agentImage?.responsibilities?.slice(0, 3)
                        || roleDef?.responsibilities?.slice(0, 3)
                        || [];
                    const capabilities: string[] = (_agentImage as any)?.capabilities || [];
                    const agentImageDescription = _agentImage?.description;
                    const scope = (_agentImage as any)?.scopeOfResponsibility;
                    const scopeSummary = scope?.ownedPaths?.length
                        ? [
                            `Owned paths: ${scope.ownedPaths.join(', ')}`,
                            scope.forbiddenPaths?.length ? `forbidden: ${scope.forbiddenPaths.join(', ')}` : null,
                        ].filter(Boolean).join('; ')
                        : undefined;

                    let introContent: string = '';

                    if (isBootstrapRole(role, _agentImage)) {
                        logger.debug('[runClaude] Bootstrap role — skipping team handshake (silent mode)');
                        console.log(`[Team] 🔇 ${roleTitle} working silently (bootstrap mode)`);
                    } else {
                        const roleSummary = agentImageDescription || roleDef?.name || roleTitle;
                        introContent = buildAgentHandshakeContent({
                            role: role!,
                            roleTitle,
                            isCoordinator: isCoordinatorRole(role, _agentImage),
                            isBootstrap: isBootstrapRole(role, _agentImage),
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
                    if (!isBootstrapRole(role, _agentImage)) {
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
                if (teamData && !isCoordinatorRole(role, _agentImage) && !isBootstrapRole(role, _agentImage)) {
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

                // ── Genome Tier 1：Prompt 注入 ───────────────────────────────────────
                // Use _agentImageRef.current (updated by hot-evolution interval) so
                // an evolved systemPrompt takes effect on the next turn without restart.
                // Falls back to startup _agentImage if ref was not set (ad-hoc agents).
                const _currentGenome = _agentImageRef.current ?? _agentImage;
                if (_currentGenome?.systemPrompt) {
                    instructions = resolvePromptTemplateVars(_currentGenome.systemPrompt, {
                        // Self-mirror: identity fields so genome prompts can reference the agent's own state
                        AHA_SESSION_ID: response.id,
                        AHA_SPEC_ID: _agentImageId || '(none)',
                        AHA_SPEC_VERSION: String(_currentGenome.version ?? '?'),
                        AHA_DISPLAY_NAME: (metadata as { displayName?: string } | undefined)?.displayName || role || 'agent',
                        AHA_AGENT_ROLE: role || 'agent',
                        AHA_TEAM_ID: teamId || process.env.AHA_ROOM_ID || '(unknown-team)',
                        // Supervisor cursor state
                        AHA_SUPERVISOR_TEAM_LOG_CURSOR: process.env.AHA_SUPERVISOR_TEAM_LOG_CURSOR || '0',
                        AHA_SUPERVISOR_LAST_CONCLUSION: process.env.AHA_SUPERVISOR_LAST_CONCLUSION || '(none — this is the first run)',
                        AHA_SUPERVISOR_PENDING_ACTION: process.env.AHA_SUPERVISOR_PENDING_ACTION || '(none)',
                        AHA_SUPERVISOR_CC_LOG_CURSORS: process.env.AHA_SUPERVISOR_CC_LOG_CURSORS || '{}',
                        AHA_SUPERVISOR_CODEX_HISTORY_CURSOR: process.env.AHA_SUPERVISOR_CODEX_HISTORY_CURSOR || '0',
                        AHA_SUPERVISOR_CODEX_SESSION_CURSORS: process.env.AHA_SUPERVISOR_CODEX_SESSION_CURSORS || '{}',
                        AHA_SUPERVISOR_LAST_SESSION_ID: process.env.AHA_SUPERVISOR_LAST_SESSION_ID || '(none)',
                        AHA_SUPERVISOR_PENDING_ACTION_BLOCK: buildPendingActionBlock(),
                    });
                    if (_currentGenome.systemPromptSuffix) {
                        instructions += '\n\n' + _currentGenome.systemPromptSuffix;
                    }
                    logger.debug(`[genome] Using genome systemPrompt (specId=${_agentImageId}, v${_currentGenome.version ?? '?'})`);
                } else if (_agentImageId || _agentImage) {
                    throw new Error(
                        `[runClaude] Missing required genome systemPrompt for role=${role ?? 'agent'} specId=${_agentImageId ?? 'unknown'}`,
                    );
                } else {
                    // Ad-hoc agents spawned without a genome still need a minimal safe instruction block.
                    logger.warn(`[runClaude] Agent role=${role} started without genome; using minimal fallback`);
                    instructions = `You are a team agent with role: ${role || 'agent'}. Follow your team's kanban board and messaging protocol. Call get_team_info and list_tasks to understand your context.`;
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

💡 CONTEXT WINDOW: Call \`get_context_status\` at the start of any large task to check how much context you have remaining. Your context limit is ${Math.round((resolveContextWindowTokens(currentModel) ?? DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS) / 1000)}K tokens.

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
                const rolePromptForContext = generateRolePrompt(sessionMetadataForContext, joinKanbanContext, _agentImage ?? undefined, _agentVerdictData);
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
        let modelSelectionChanged = false;
        if (metadata.modelOverride && metadata.modelOverride !== currentModel) {
            currentModel = metadata.modelOverride;
            logger.debug(`[runClaude] Model override updated via metadata: ${currentModel}`);
            modelSelectionChanged = true;
        }
        if (metadata.fallbackModelOverride && metadata.fallbackModelOverride !== currentFallbackModel) {
            currentFallbackModel = metadata.fallbackModelOverride;
            logger.debug(`[runClaude] Fallback model override updated via metadata: ${currentFallbackModel}`);
            modelSelectionChanged = true;
        }
        if (modelSelectionChanged) {
            sanitizeCurrentFallbackModel('session metadata');
            syncModelAwareness();
        }

        recomputeEffectiveRuntimeToolAccess(metadata, 'metadata-update');
        syncRuntimePermissionMetadata();

        if (changed) {
            updateTeamHandling(currentTeamId, currentRole, isNewJoin);
        }
    });

    // Note: Team handling will be initialized AFTER loop starts (see below)

    session.onUserMessage((message) => {

        // Resolve permission mode from meta
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: Array<NonNullable<StartOptions['permissionMode']>> = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
            if (validModes.includes(message.meta.permissionMode as NonNullable<StartOptions['permissionMode']>)) {
                messagePermissionMode = message.meta.permissionMode as NonNullable<StartOptions['permissionMode']>;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);
                syncRuntimePermissionMetadata();

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
        const sanitizedMessageFallbackModel = sanitizeFallbackModel(messageModel, messageFallbackModel);
        if (sanitizedMessageFallbackModel !== messageFallbackModel) {
            logger.debug(
                `[runClaude] Clearing message fallback model because it matches primary model: ${messageModel}`,
            );
        }
        messageFallbackModel = sanitizedMessageFallbackModel;
        currentFallbackModel = sanitizedMessageFallbackModel;
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
            baselineAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            logger.debug(`[loop] Allowed tools baseline updated from user message`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            baselineDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            logger.debug(`[loop] Disallowed tools baseline updated from user message`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        recomputeEffectiveRuntimeToolAccess(session.getMetadata(), 'message-dispatch');
        messageAllowedTools = currentAllowedTools;
        messageDisallowedTools = currentDisallowedTools;
        syncRuntimePermissionMetadata();

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        const sessionMetadata = session.getMetadata() || {} as any;
        const role = sessionMetadata.role;

        // Resolve permission mode - check message override first, then options
        const requestedMode = messagePermissionMode || options.permissionMode;

        // Get role-based permissions
        const { permissionMode: effectivePermissionMode, disallowedTools: roleDisallowedTools } =
            getRolePermissions(role, requestedMode);

        const rolePrompt = generateRolePrompt(sessionMetadata, undefined, _agentImage ?? undefined, _agentVerdictData);

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
            logger.debugLargeJson('[start] /clear command pushed to queue:', message);
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
                clearInterval(keepAliveInterval);
                if (_hotEvolutionInterval) clearInterval(_hotEvolutionInterval);
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

    // Extract SDK metadata in background using the same runtime inputs as the live
    // Claude session so metadata.tools reflects the real surfaced contract.
    setTimeout(() => {
        extractSDKMetadataAsync(async (sdkMetadata) => {
            logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
            try {
                await session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    tools: sdkMetadata.tools,
                    slashCommands: sdkMetadata.slashCommands,
                }));
                logger.debug('[start] Session metadata updated with SDK capabilities');
            } catch (error) {
                logger.debug('[start] Failed to update session metadata:', error);
            }
        }, {
            cwd: _workspacePlan?.effectiveCwd ?? workingDirectory,
            allowedTools: currentAllowedTools,
            disallowedTools: currentDisallowedTools,
            permissionMode: currentPermissionMode,
            settingsPath: _workspacePlan?.settingsPath ?? _prebuiltSettingsPath,
            mcpServers,
        });
    }, 1500);

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
                currentLoopMode = newMode;
                session.keepAlive(false, currentLoopMode);
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
        clearInterval(keepAliveInterval);
        // Workspace directories are permanent; no cleanup needed.
    }

    const finalSessionMetadata = (session.getMetadata() || {}) as Metadata;
    if (finalSessionMetadata.lifecycleState === 'auto-retired' || finalSessionMetadata.lifecycleState === 'retired') {
        const closedAt = finalSessionMetadata.closedAt || new Date().toISOString();
        await completeRunEnvelope({
            runId: response.id,
            status: 'completed',
            closedAt,
            retiredAt: finalSessionMetadata.retiredAt || closedAt,
            lifecycleState: finalSessionMetadata.lifecycleState,
        });
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
