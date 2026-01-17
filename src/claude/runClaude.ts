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
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { resolve } from 'node:path';
import { getRolePermissions, generateRolePrompt } from './team/roles';

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
From: ${message.fromDisplayName || message.fromSessionId?.substring(0, 8) || 'Unknown'} (${message.fromRole || 'unknown'})
Type: ${message.type || 'chat'}
Time: ${new Date(message.timestamp).toLocaleString()}

${message.content}

${isMentioned ? `⚠️  You were mentioned in this message.
💡 Your role: ${myRole}
📌 Please respond to this message in the team chat.` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
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
            logger.debug(`[START] Ignoring unknown HAPPY_PERMISSION_MODE value: ${rawMode}`);
            return undefined;
    }
}

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = options.sessionTag || randomUUID();

    if (!options.permissionMode) {
        const envPermissionMode = resolveEnvPermissionMode(process.env.HAPPY_PERMISSION_MODE);
        if (envPermissionMode) {
            options.permissionMode = envPermissionMode;
            logger.debug(`[START] Permission mode initialized from env: ${envPermissionMode}`);
        }
    }
    if (!options.permissionMode && process.env.HAPPY_ROOM_ID) {
        options.permissionMode = 'bypassPermissions';
        logger.debug(`[START] Permission mode defaulted to bypass for team session ${process.env.HAPPY_ROOM_ID}`);
    }

    // Log environment info at startup
    logger.debugLargeJson('[START] Happy process started', getEnvironmentInfo());
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

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexepcted since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
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
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude'
    };
    if (process.env.HAPPY_AGENT_ROLE) {
        metadata.role = process.env.HAPPY_AGENT_ROLE;
        logger.debug(`[runClaude] Setting metadata.role from env: ${process.env.HAPPY_AGENT_ROLE}`);
    }
    const roomIdFromEnv = process.env.HAPPY_ROOM_ID;
    if (roomIdFromEnv) {
        metadata.teamId = roomIdFromEnv;
        metadata.roomId = roomIdFromEnv;
        logger.debug(`[runClaude] Setting metadata.teamId from env: ${roomIdFromEnv}`);
    }
    logger.debug(`[runClaude] Final metadata before session creation:`, { role: metadata.role, teamId: metadata.teamId });
    if (process.env.HAPPY_ROOM_NAME) {
        metadata.roomName = process.env.HAPPY_ROOM_NAME;
        metadata.name = process.env.HAPPY_ROOM_NAME;
    }
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    logger.debug(`Session created: ${response.id}`);
    logger.debug(`[runClaude] Response metadata from server:`, { role: response.metadata?.role, teamId: response.metadata?.teamId });

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

    // Start Happy MCP server
    const happyServer = await startHappyServer(api, session);
    logger.debug(`[START] Happy MCP server started at ${happyServer.url}`);
    const desktopMcpUrl = process.env.HAPPY_DESKTOP_MCP_URL;
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
    let currentModel = options.model; // Track current model state
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt

    // Implant Context (Rules & Preferences)
    let currentAppendSystemPrompt: string | undefined = undefined;
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
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools

    // Initialize role from environment variables first, fallback to session metadata
    logger.debug(`[runClaude] Initializing role - env: ${process.env.HAPPY_AGENT_ROLE}, metadata: ${session.getMetadata()?.role}`);
    let currentRole: string | undefined = process.env.HAPPY_AGENT_ROLE || session.getMetadata()?.role;
    if (currentRole) {
        logger.debug(`[runClaude] Initialized with role: ${currentRole}`);
    }

    // Initialize teamId from environment variables first, fallback to session metadata
    logger.debug(`[runClaude] Initializing teamId - env: ${process.env.HAPPY_ROOM_ID}, metadata: ${session.getMetadata()?.teamId}`);
    let currentTeamId: string | undefined = process.env.HAPPY_ROOM_ID || session.getMetadata()?.teamId;
    let cleanupTeamHandling: (() => void) | undefined;

    // Function to setup/update team handling
    const updateTeamHandling = async (teamId: string | undefined, role: string | undefined, isNewJoin: boolean) => {
        // Cleanup existing listener if any
        if (cleanupTeamHandling) {
            cleanupTeamHandling();
            cleanupTeamHandling = undefined;
        }

        if (teamId && role) {
            logger.debug(`[runClaude] Session is part of team ${teamId} with role ${role}`);

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

                        // Determine if this agent should respond
                        // Check for direct session ID mention OR role name mention (e.g. @builder)
                        const contentLower = (message.content || '').toLowerCase();
                        const isRoleMentioned = role && contentLower.includes(`@${role.toLowerCase()}`);
                        const isMentioned = message.mentions?.includes(response.id) || isRoleMentioned || false;

                        const isUrgent = message.metadata?.priority === 'urgent';
                        const isTaskUpdate = message.type === 'task-update';

                        const fromRole = message.fromRole;
                        const isFromUser = !fromRole || fromRole === 'user'; // No role OR explicit "user" role
                        const isFromMaster = fromRole === 'master';

                        const amIMaster = role === 'master';
                        const amIWorker = ['builder', 'framer', 'reviewer'].includes(role || '');

                        // Master receives ALL messages to orchestrate the workflow.
                        // Workers listen to Master, User, and Mentions.
                        // STRICTLY IGNORE other workers unless mentioned.

                        let shouldRespond = false;

                        if (amIMaster) {
                            // Master sees everything and decides what to do
                            // Master should also pay attention to task updates to monitor progress
                            shouldRespond = true;
                        } else if (amIWorker) {
                            // Workers logic:
                            // 1. Always respond if mentioned
                            // 2. Respond if message is from Master
                            // 3. Respond if message is from User (no role)
                            // 4. Respond if it is a task update (to keep context synced)
                            // 5. IGNORE messages from other workers (builder, framer, reviewer) unless mentioned

                            if (isMentioned) {
                                shouldRespond = true;
                            } else if (isFromMaster) {
                                shouldRespond = true;
                            } else if (isFromUser) {
                                shouldRespond = true;
                            } else if (isTaskUpdate) {
                                shouldRespond = true;
                            } else {
                                // Message from another worker and NOT mentioned -> IGNORE
                                shouldRespond = false;
                            }
                        } else {
                            // Fallback for unassigned roles or others
                            shouldRespond = isMentioned || isUrgent || isTaskUpdate;
                        }

                        console.log(`[Team] Should respond? ${shouldRespond} (Role:${role}, From:${fromRole || 'User'}, Mentioned:${isMentioned})`);

                        if (shouldRespond) {
                            logger.debug(`[runClaude] Injecting team message (mentioned:${isMentioned}, urgent:${isUrgent}, fromMaster:${isFromMaster})`);

                            // Format the message for injection
                            const formattedMessage = formatTeamMessage(message, teamId!, role!, isMentioned);

                            // Inject into message queue
                            const enhancedMode: EnhancedMode = {
                                permissionMode: currentPermissionMode || 'default',
                                model: currentModel,
                                fallbackModel: currentFallbackModel,
                                customSystemPrompt: currentCustomSystemPrompt,
                                appendSystemPrompt: currentAppendSystemPrompt,
                                allowedTools: currentAllowedTools,
                                disallowedTools: currentDisallowedTools
                            };

                            messageQueue.push(formattedMessage, enhancedMode);
                            console.log('[Team] ✅ Message injected into queue');
                            logger.debug('[runClaude] Team message injected into queue');
                        } else {
                            logger.debug(`[runClaude] Team message received but not injecting (not relevant for this role)`);
                        }
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

                // 1. Send Handshake
                try {
                    const handshakeMsg = {
                        id: randomUUID(),
                        teamId,
                        content: `[System] Agent ${response.id} (Role: ${role}) is online and ready.`,
                        type: 'system',
                        timestamp: Date.now(),
                        fromSessionId: response.id,
                        fromRole: role,
                        metadata: { type: 'handshake' }
                    };
                    await api.sendTeamMessage(teamId, handshakeMsg);
                    logger.debug('[runClaude] Sent handshake message to team');
                } catch (e) {
                    logger.debug('[runClaude] Failed to send handshake:', e);
                }

                // 2. Inject Context (Team Artifact + Recent Messages)
                try {
                    // Fetch Team Artifact
                    const artifact = await api.getArtifact(teamId);
                    const teamData = artifact.body;
                    const teamName = typeof artifact.header === 'string' ? artifact.header : 'Team';

                    // Fetch Recent Messages (Context)
                    // Try to get from local storage first, or maybe we should fetch from server if we want true history?
                    // For now, let's assume local storage has some history if we've been here before.
                    // If it's a fresh join on a new machine, we might miss history.
                    // ideally we should have an API to fetch recent team messages.
                    // But since we don't have that API handy in ApiClient yet (only sendTeamMessage), 
                    // we rely on what we have or just the artifact.

                    // Let's try to read local storage context
                    const recentMessages = await teamStorage.getRecentContext(teamId, 20);
                    const historyText = summarizeHistory(recentMessages);

                    // Filter Kanban Board for Context Isolation
                    let filteredBoard = { ...teamData };
                    if (role !== 'master') {
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

                    let instructions = `
1. Review the team agreements and your role responsibilities.
2. Wait for instructions from the Master agent or User.
3. Use the team chat for all project-related communication.`;

                    if (role === 'master') {
                        instructions = `
1. 🚨 YOU ARE THE MASTER COORDINATOR.
2. CHECK the Kanban board above.
3. IF the board is empty or has only a goal, you MUST call 'create_task' to break down the work.
4. ASSIGN tasks to your team members (Builder, Framer, etc.).
5. REPORT your plan to the team via 'send_team_message'.
6. DO NOT WAIT. START NOW.`;
                    }

                    const contextMsg = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📢 TEAM ASSIGNMENT: ${teamName}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You have been assigned to this team with role: ${role}.

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

                    const enhancedMode: EnhancedMode = {
                        permissionMode: effectivePermissionMode,
                        model: currentModel,
                        fallbackModel: currentFallbackModel,
                        customSystemPrompt: currentCustomSystemPrompt,
                        appendSystemPrompt: currentAppendSystemPrompt,
                        allowedTools: currentAllowedTools,
                        disallowedTools: [...(currentDisallowedTools || []), ...roleDisallowedTools]
                    };

                    // Use pushIsolateAndClear to ensure the agent starts with a clean slate for the new team
                    // This prevents context leakage from previous teams or sessions
                    messageQueue.pushIsolateAndClear(contextMsg, enhancedMode);
                    logger.debug('[runClaude] Injected team context into queue (cleared previous context)');
                } catch (e) {
                    logger.debug('[runClaude] Failed to fetch/inject team context:', e);
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

        const rolePrompt = generateRolePrompt(sessionMetadata);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            const enhancedMode: EnhancedMode = {
                permissionMode: effectivePermissionMode,
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: (messageAppendSystemPrompt || '') + rolePrompt,
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
                appendSystemPrompt: (messageAppendSystemPrompt || '') + rolePrompt,
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
            appendSystemPrompt: (messageAppendSystemPrompt || '') + rolePrompt,
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

            // Stop Happy MCP server
            happyServer.stop();

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

    const mcpServers: Record<string, { type: string; url: string }> = {
        happy: {
            type: 'http',
            url: happyServer.url,
        },
    };
    if (desktopMcpUrl) {
        mcpServers['happy-desktop'] = {
            type: 'http',
            url: desktopMcpUrl,
        };
    }

    // Initialize team handling after a delay to ensure loop is running
    // This allows handshake and context injection to work properly
    setTimeout(async () => {
        if (currentTeamId && currentRole) {
            logger.debug('[runClaude] Delayed team initialization starting...');

            // Update session metadata with teamId/role/name/path
            // This ensures metadata is encrypted with Happy-CLI's key (not Kanban's)
            try {
                const updateData: Record<string, any> = {
                    teamId: currentTeamId,
                    role: currentRole
                };

                // Preserve name and path from environment or existing metadata
                const sessionName = process.env.HAPPY_SESSION_NAME;
                if (sessionName) {
                    updateData.name = sessionName;
                }

                const sessionPath = process.env.HAPPY_SESSION_PATH || workingDirectory;
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
    await loop({
        path: workingDirectory,
        model: options.model,
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
        claudeArgs: options.claudeArgs
    });

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

    // Stop Happy MCP server
    happyServer.stop();
    logger.debug('Stopped Happy MCP server');

    // Exit
    process.exit(0);
}
