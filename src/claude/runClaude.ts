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
import { getRolePermissions, generateRolePrompt, shouldListenTo, COORDINATION_ROLES, KanbanContext } from './team/roles';
import { DEFAULT_ROLES } from './team/roles.config';
import { TEAM_ROLE_LIBRARY } from '@aha/shared-team-config';
import { TaskStateManager } from './utils/taskStateManager';
import { StatusReporter, createStatusReporter } from './team/statusReporter';
import { ApprovalWorkflow, createApprovalWorkflow } from './team/approvalWorkflow';

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

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexepcted since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/aha-cli/issues`);
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
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude'
    };
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
    logger.debug(`[runClaude] Final metadata before session creation:`, { role: metadata.role, teamId: metadata.teamId });
    if (process.env.AHA_ROOM_NAME) {
        metadata.roomName = process.env.AHA_ROOM_NAME;
    }
    // Priority: AHA_SESSION_NAME > AHA_ROOM_NAME
    metadata.name = process.env.AHA_SESSION_NAME || process.env.AHA_ROOM_NAME;
    if (metadata.name) {
        logger.debug(`[runClaude] Setting metadata.name: ${metadata.name}`);
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

    // Start Aha MCP server
    const ahaServer = await startAhaServer(api, session);
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

            // Initialize ApprovalWorkflow for coordination roles (master, orchestrator, team-lead)
            if (COORDINATION_ROLES.includes(role)) {
                approvalWorkflow = createApprovalWorkflow(api, taskStateManager, teamId, response.id, role);
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

                        // Determine if this agent should respond
                        // Check for direct session ID mention OR role name mention (e.g. @builder)
                        const contentLower = (message.content || '').toLowerCase();
                        const isRoleMentioned = role && contentLower.includes(`@${role.toLowerCase()}`);
                        const isMentioned = message.mentions?.includes(response.id) || isRoleMentioned || false;

                        const isUrgent = message.metadata?.priority === 'urgent';
                        const isTaskUpdate = message.type === 'task-update';

                        const fromRole = message.fromRole;
                        const isFromUser = !fromRole || fromRole === 'user';

                        // 1. Self-filter: IGNORE messages from myself
                        if (message.fromSessionId === response.id) {
                            logger.debug(`[Team] Ignoring my own message`);
                            return;
                        }

                        // =============================================================
                        // NEW COLLABORATION MODEL: Peer-to-Peer Communication
                        // =============================================================
                        // Each role has a defined set of collaborators they listen to.
                        // This removes the master bottleneck and enables direct teamwork.
                        // =============================================================

                        let shouldRespond = false;

                        // Priority 1: Always respond if directly mentioned
                        if (isMentioned) {
                            shouldRespond = true;
                            logger.debug(`[Team] Responding: directly mentioned`);
                        }
                        // Priority 2: Always respond to urgent messages
                        else if (isUrgent) {
                            shouldRespond = true;
                            logger.debug(`[Team] Responding: urgent message`);
                        }
                        // Priority 3: Check role collaboration map
                        else if (role && shouldListenTo(role, fromRole)) {
                            shouldRespond = true;
                            logger.debug(`[Team] Responding: ${role} listens to ${fromRole || 'user'}`);
                        }
                        // Priority 4: Coordination roles respond to task updates
                        else if (isTaskUpdate && COORDINATION_ROLES.includes(role || '')) {
                            shouldRespond = true;
                            logger.debug(`[Team] Responding: coordinator receiving task update`);
                        }
                        // Otherwise: don't respond
                        else {
                            logger.debug(`[Team] Not responding: ${role} does not listen to ${fromRole || 'user'}`);
                        }

                        console.log(`[Team] Should respond? ${shouldRespond} (Role:${role}, From:${fromRole || 'User'}, Mentioned:${isMentioned}, Collaborator:${role ? shouldListenTo(role, fromRole) : 'N/A'})`);

                        if (shouldRespond) {
                            logger.debug(`[runClaude] Injecting team message (mentioned:${isMentioned}, urgent:${isUrgent}, from:${fromRole || 'user'})`);

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
                            const rolePromptForTeamMsg = generateRolePrompt(sessionMetadataForTeamMsg, kanbanContext);
                            const { disallowedTools: roleDisallowedToolsForMsg } = getRolePermissions(role, currentPermissionMode);

                            // Inject into message queue
                            const enhancedMode: EnhancedMode = {
                                permissionMode: currentPermissionMode || 'default',
                                model: currentModel,
                                fallbackModel: currentFallbackModel,
                                customSystemPrompt: currentCustomSystemPrompt,
                                appendSystemPrompt: (currentAppendSystemPrompt || '') + rolePromptForTeamMsg,
                                allowedTools: currentAllowedTools,
                                disallowedTools: [...(currentDisallowedTools || []), ...roleDisallowedToolsForMsg]
                            };

                            messageQueue.push(formattedMessage, enhancedMode);
                            console.log('[Team] ✅ Message injected into queue');
                            logger.debug('[runClaude] Team message injected into queue with role prompt');
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

                // 1. Send Handshake - Role-specific introduction
                try {
                    const roleDef = DEFAULT_ROLES[role!];
                    const roleTitle = roleDef?.name || role;
                    const roleResponsibilities = roleDef?.responsibilities?.slice(0, 3) || [];

                    let introContent: string;

                    if (role === 'master' || role === 'orchestrator') {
                        // Master/Orchestrator: Announce leadership and request status
                        introContent = `🎯 **${roleTitle}** reporting for duty!

**My Role:** I will coordinate this team and manage task distribution.

**Immediate Actions:**
1. Review the project requirements
2. Break down work into actionable tasks
3. Assign tasks to team members

📢 **Team Members:** Please report your status and availability. I will begin task assignment shortly.`;
                    } else {
                        // Other roles: Report availability and capabilities
                        const responsibilitiesText = roleResponsibilities.length > 0
                            ? roleResponsibilities.map((r, i) => `${i + 1}. ${r}`).join('\n')
                            : 'Ready to assist the team';

                        introContent = `✅ **${roleTitle}** online and ready!

**My Capabilities:**
${responsibilitiesText}

Awaiting task assignment from @master or @orchestrator.`;
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
                    await api.sendTeamMessage(teamId, handshakeMsg);
                    logger.debug('[runClaude] Sent handshake message to team');
                    console.log(`[Team] 📢 ${roleTitle} announced presence in team chat`);
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
                if (teamData && role !== 'master' && role !== 'orchestrator') {
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

                let instructions: string;

                if (role === 'master' || role === 'orchestrator') {
                    // Coordinator instructions - OhMyOpenCode / Sisyphus pattern
                    instructions = `
<Coordinator_Instructions>

## Your Role: TEAM COORDINATOR

You coordinate the team. You DO NOT do implementation work yourself.

## 🚨 MANDATORY STARTUP SEQUENCE (EXECUTE IMMEDIATELY)

Before doing ANYTHING else, you MUST complete these steps IN ORDER:

1. **CALL \`get_team_info\`** - Understand who is on your team
2. **CALL \`list_tasks\`** - See current kanban board state
3. **SEND STATUS REPORT** via \`send_team_message\`:
   \`\`\`
   🎯 [MASTER] Team Status Report
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Team Members Online: [list each member with role]
   Current Tasks: [summary of kanban state]
   Status: Ready for instructions
   \`\`\`

**DO NOT SKIP THIS SEQUENCE. DO NOT SAY "Ready and waiting" WITHOUT FIRST COMPLETING STEPS 1-3.**

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
3. **PLAN** by creating tasks via 'create_task' (only when asked)
4. **ASSIGN** tasks to appropriate roles (builder, framer, reviewer) using team roster from get_team_info
5. **ANNOUNCE** plan via 'send_team_message'
6. **MONITOR** progress, resolve blockers

## Anti-Patterns (BLOCKING)

| Pattern | Problem |
|---------|---------|
| Reading files to find work | Inventing tasks |
| Creating tasks without user request | Scope creep |
| Starting implementation yourself | Wrong role |
| Saying "ready" without calling get_team_info first | No team awareness |

**NO USER INSTRUCTION = WAIT. DO NOT explore files for "tasks to do".**

</Coordinator_Instructions>`;
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
                const rolePromptForContext = generateRolePrompt(sessionMetadataForContext, joinKanbanContext);
                logger.debug(`[runClaude] Generated role prompt for context injection (role: ${role})`);

                const enhancedMode: EnhancedMode = {
                    permissionMode: effectivePermissionMode,
                    model: currentModel,
                    fallbackModel: currentFallbackModel,
                    customSystemPrompt: currentCustomSystemPrompt,
                    appendSystemPrompt: (currentAppendSystemPrompt || '') + rolePromptForContext,
                    allowedTools: currentAllowedTools,
                    disallowedTools: [...(currentDisallowedTools || []), ...roleDisallowedTools]
                };

                // Use pushIsolateAndClear to ensure the agent starts with a clean slate for the new team
                // This prevents context leakage from previous teams or sessions
                messageQueue.pushIsolateAndClear(contextMsg, enhancedMode);
                logger.debug('[runClaude] Injected team context into queue (cleared previous context) with role prompt');
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

    const mcpServers: Record<string, { type: string; url: string }> = {
        aha: {
            type: 'http',
            url: ahaServer.url,
        },
    };
    if (desktopMcpUrl) {
        mcpServers['aha-desktop'] = {
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

    // Stop Aha MCP server
    ahaServer.stop();
    logger.debug('Stopped Aha MCP server');

    // Exit
    process.exit(0);
}
