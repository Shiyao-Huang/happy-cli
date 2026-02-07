import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { AgentState, Metadata, UpdateArtifactBody } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import os from 'node:os';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { resolve, join } from 'node:path';
import fs from 'node:fs';
import { startAhaServer } from '@/claude/utils/startAhaServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import type { CodexSessionConfig } from './types';
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { delay } from "@/utils/time";
import { stopCaffeinate } from "@/utils/caffeinate";
import { Client as McpHttpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// Team collaboration imports
import { TaskStateManager } from '@/claude/utils/taskStateManager';
import { StatusReporter, createStatusReporter } from '@/claude/team/statusReporter';
import { COORDINATION_ROLES } from '@/claude/team/roles';
import { TeamMessageStorage } from '@/claude/team/teamMessageStorage';
import { TEAM_ROLE_LIBRARY } from '@aha/shared-team-config';

// Helper functions for role metadata
function getRoleTitle(roleId: string): string {
    const role = TEAM_ROLE_LIBRARY.find((r: any) => r.id === roleId);
    return role?.title || roleId;
}

function getRoleResponsibilities(roleId: string): string[] {
    const role = TEAM_ROLE_LIBRARY.find((r: any) => r.id === roleId);
    return role?.responsibilities || [];
}

type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
    if (shouldExit) {
        return false;
    }
    if (pending) {
        return false;
    }
    if (queueSize() > 0) {
        return false;
    }

    sendReady();
    notify?.();
    return true;
}

type CodexPermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

function resolveCodexPermissionMode(rawMode?: string): CodexPermissionMode | undefined {
    if (!rawMode) {
        return undefined;
    }
    const normalized = rawMode.trim().toLowerCase();
    switch (normalized) {
        case 'default':
            return 'default';
        case 'read-only':
        case 'readonly':
            return 'read-only';
        case 'safe-yolo':
        case 'safe_yolo':
        case 'safe':
            return 'safe-yolo';
        case 'yolo':
        case 'bypass':
        case 'bypasspermissions':
            return 'yolo';
        default:
            logger.debug(`[Codex] Ignoring unknown AHA_PERMISSION_MODE value: ${rawMode}`);
            return undefined;
    }
}

type DesktopKanbanRole = {
    id?: string;
    title?: string;
    summary?: string;
    abilityBoundaries?: string[];
    handoffProtocol?: string[];
};

type DesktopKanbanMember = {
    sessionId?: string;
    roleId?: string;
    displayName?: string;
};

type DesktopKanbanAgreements = {
    statusUpdates?: string;
    handoffs?: string;
    escalation?: string;
    definitionOfDone?: string;
};

type DesktopKanbanState = {
    room?: { id?: string; name?: string; description?: string };
    board?: {
        team?: {
            members?: DesktopKanbanMember[];
            roles?: DesktopKanbanRole[];
            agreements?: DesktopKanbanAgreements;
        }
    };
};

async function fetchDesktopKanbanState(desktopMcpUrl: string, roomId: string): Promise<DesktopKanbanState | null> {
    const client = new McpHttpClient(
        { name: 'aha-cli-kanban-bootstrap', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );
    let transport: StreamableHTTPClientTransport | null = null;

    try {
        transport = new StreamableHTTPClientTransport(new URL(desktopMcpUrl));
        await client.connect(transport);
        const response: any = await client.callTool({
            name: 'kanban_get_room_state',
            arguments: { roomId }
        });

        const content = Array.isArray(response?.content) ? response.content : [];
        const textEntry = content.find((entry: any) => entry?.type === 'text' && typeof entry.text === 'string');
        if (!textEntry) {
            return null;
        }

        try {
            // The content is already an object if the server returns it as such, 
            // but the MCP SDK types say content is text.
            // If the server returns JSON directly, we might not need to parse it if the transport handles it.
            // However, looking at kanbanServer.js:164, it uses #jsonResponse which likely stringifies it.
            // Let's check if it's already an object first.
            if (typeof textEntry.text === 'object') {
                return textEntry.text;
            }
            return JSON.parse(textEntry.text as string);
        } catch (error) {
            logger.debug('[Codex] Failed to parse Kanban MCP payload', error);
            // Fallback: maybe it's already the object?
            return textEntry.text as unknown as DesktopKanbanState;
        }
    } catch (error) {
        logger.debug('[Codex] Failed to fetch Kanban room state', error);
        return null;
    } finally {
        try { await client.close(); } catch { }
        try { await transport?.close?.(); } catch { }
    }
}

function resolveRoleByIdOrLabel(
    roles: DesktopKanbanRole[] | undefined,
    needle?: string
): DesktopKanbanRole | null {
    if (!roles || !needle) {
        return null;
    }
    const lowerNeedle = needle.toLowerCase();
    return roles.find((role) =>
        role.id?.toLowerCase() === lowerNeedle ||
        role.title?.toLowerCase() === lowerNeedle
    ) ?? null;
}

function resolveRoleTitle(roles: DesktopKanbanRole[] | undefined, roleId?: string): string | undefined {
    const match = resolveRoleByIdOrLabel(roles, roleId);
    return match?.title ?? roleId;
}

function formatKanbanInstructionBlock(
    state: DesktopKanbanState,
    opts: { roleId?: string; roleLabel?: string; memberId?: string }
): string | null {
    const team = state.board?.team;
    if (!team) {
        return null;
    }

    const roles = Array.isArray(team.roles) ? team.roles : [];
    const roster = Array.isArray(team.members) ? team.members : [];
    const agreements = team.agreements;
    const roomName = state.room?.name || state.room?.id || 'team room';
    const lines: string[] = [];

    lines.push(`Team context for Kanban room "${roomName}".`);

    if (roster.length) {
        lines.push(`Roster (${roster.length} agents with tracked roles):`);
        roster.slice(0, 5).forEach((member) => {
            const label = member.displayName || member.sessionId || 'unknown member';
            const roleTitle = resolveRoleTitle(roles, member.roleId) || member.roleId || 'unassigned';
            const identifier = member.sessionId ? ` [${member.sessionId}]` : '';
            lines.push(`- ${label}${identifier}: ${roleTitle}`);
        });
        if (roster.length > 5) {
            lines.push(`- …${roster.length - 5} more not listed to save tokens.`);
        }
    }

    if (roles.length) {
        lines.push('Role charters and guardrails:');
        roles.forEach((role) => {
            const fragments: string[] = [];
            if (role.summary) {
                fragments.push(role.summary);
            }
            if (role.abilityBoundaries?.length) {
                fragments.push(`Boundaries: ${role.abilityBoundaries.join('; ')}`);
            }
            if (role.handoffProtocol?.length) {
                fragments.push(`Handoff: ${role.handoffProtocol.slice(0, 2).join('; ')}`);
            }
            lines.push(`- ${role.title || role.id}: ${fragments.join(' ')}`);
        });
    }

    if (agreements) {
        lines.push('Working agreements to respect:');
        if (agreements.statusUpdates) {
            lines.push(`- Status updates: ${agreements.statusUpdates}`);
        }
        if (agreements.handoffs) {
            lines.push(`- Handoffs: ${agreements.handoffs}`);
        }
        if (agreements.escalation) {
            lines.push(`- Escalation: ${agreements.escalation}`);
        }
        if (agreements.definitionOfDone) {
            lines.push(`- Definition of Done: ${agreements.definitionOfDone}`);
        }
    }

    const assignedMember = opts.memberId
        ? roster.find((member) => member.sessionId === opts.memberId)
        : null;
    let resolvedRole =
        resolveRoleByIdOrLabel(roles, opts.roleId) ||
        resolveRoleByIdOrLabel(roles, opts.roleLabel) ||
        resolveRoleByIdOrLabel(roles, assignedMember?.roleId);

    if (!resolvedRole && opts.roleId) {
        // Still note the role even if we lack metadata to expand it.
        lines.push(`You are operating under role "${opts.roleId}". Use the roster above to stay aligned.`);
    }

    if (resolvedRole) {
        const guardrails = resolvedRole.abilityBoundaries?.join('; ') || resolvedRole.summary;
        lines.push(`You are operating as ${opts.roleLabel || resolvedRole.title || resolvedRole.id}. Guardrails: ${guardrails ?? 'Respect the charter above.'}`);
        if (resolvedRole.handoffProtocol?.length) {
            lines.push(`Preferred collaboration protocol: ${resolvedRole.handoffProtocol.join('; ')}`);
        }
    }

    return lines.join('\n');
}

async function buildKanbanInstructionBlock(opts: {
    desktopMcpUrl: string;
    roomId: string;
    roleId?: string;
    roleLabel?: string;
    memberId?: string;
}): Promise<string | null> {
    const state = await fetchDesktopKanbanState(opts.desktopMcpUrl, opts.roomId);
    if (!state) {
        return null;
    }
    return formatKanbanInstructionBlock(state, {
        roleId: opts.roleId,
        roleLabel: opts.roleLabel,
        memberId: opts.memberId
    });
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    type PermissionMode = CodexPermissionMode;
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
    }

    //
    // Define session
    //

    const sessionTag = randomUUID();
    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/aha-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    let state: AgentState = {
        controlledByUser: false,
    }
    let metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        ahaHomeDir: configuration.ahaHomeDir,
        ahaLibDir: projectPath(),
        ahaToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'codex'
    };
    if (process.env.AHA_AGENT_ROLE) {
        metadata.role = process.env.AHA_AGENT_ROLE;
    }
    if (process.env.AHA_ROOM_ID) {
        metadata.roomId = process.env.AHA_ROOM_ID;
    }
    if (process.env.AHA_ROOM_NAME) {
        metadata.roomName = process.env.AHA_ROOM_NAME;
        metadata.name = process.env.AHA_ROOM_NAME;
    }
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides to apply per message
    let currentPermissionMode: PermissionMode | undefined = resolveCodexPermissionMode(process.env.AHA_PERMISSION_MODE);
    if (currentPermissionMode) {
        logger.debug(`[Codex] Permission mode initialized from env: ${currentPermissionMode}`);
    }
    if (!currentPermissionMode && process.env.AHA_ROOM_ID) {
        currentPermissionMode = 'yolo';
        logger.debug(`[Codex] Permission mode defaulted to yolo for team session ${process.env.AHA_ROOM_ID}`);
    }
    let currentModel: string | undefined = undefined;

    const getCurrentEnhancedMode = (): EnhancedMode => ({
        permissionMode: currentPermissionMode ?? 'default',
        model: currentModel,
    });

    session.on('artifact-update', (update: UpdateArtifactBody) => {
        logger.debug('[Codex] Received artifact update, forwarding to agent');
        client.sendArtifactUpdate(update);
    });

    session.on('team-message', (message: any) => {
        logger.debug('[Codex] Received team message, injecting as user message');
        const senderLabel = message.fromDisplayName || message.fromRole || message.fromSessionId || 'Unknown';
        if (message.fromSessionId === session.sessionId) return;

        const content = message.content || JSON.stringify(message);
        const formattedMessage = `[Team Message from ${senderLabel}]: ${content}`;

        messageQueue.push(formattedMessage, getCurrentEnhancedMode());
    });

    session.on('metadata-update', (newMetadata: Metadata) => {
        logger.debug('[Codex] Session metadata updated', newMetadata);
        if (newMetadata.role && newMetadata.role !== metadata.role) {
            logger.debug(`[Codex] Role changed to ${newMetadata.role}`);
            const msg = `[System]: Your role has been updated to: ${newMetadata.role}. Please act accordingly.`;
            messageQueue.push(msg, getCurrentEnhancedMode());
            metadata.role = newMetadata.role;
        }
    });

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

    session.onUserMessage((message) => {
        // Resolve permission mode (validate)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Codex] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
        };
        messageQueue.push(message.content.text, enhancedMode);
    });
    let thinking = false;
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'Codex is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    let abortController = new AbortController();
    let shouldExit = false;
    let storedSessionIdForResume: string | null = null;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            // Store the current session ID before aborting for potential resume
            if (client.hasActiveSession()) {
                storedSessionIdForResume = client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            }

            abortController.abort();
            messageQueue.reset();
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

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

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    const client = new CodexMcpClient();

    // Helper: find Codex session transcript for a given sessionId
    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            // Recursively collect all files under the sessions directory
            function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return acc;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        collectFilesRecursive(full, acc);
                    } else if (entry.isFile()) {
                        acc.push(full);
                    }
                }
                return acc;
            }

            const candidates = collectFilesRecursive(rootDir)
                .filter(full => full.endsWith(`-${sessionId}.jsonl`))
                .filter(full => {
                    try { return fs.statSync(full).isFile(); } catch { return false; }
                })
                .sort((a, b) => {
                    const sa = fs.statSync(a).mtimeMs;
                    const sb = fs.statSync(b).mtimeMs;
                    return sb - sa; // newest first
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }
    const permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    client.setPermissionHandler(permissionHandler);
    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            let { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_end') {
            let { call_id, type, ...output } = msg;
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            });
        }
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            let { call_id, auto_approved, changes } = msg;

            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

            // Send tool call message
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            let { call_id, stdout, stderr, success } = msg;

            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }

            // Send tool call result message
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
    });

    // Start Aha MCP server
    const desktopMcpUrl = process.env.AHA_DESKTOP_MCP_URL;
    const ahaServer = await startAhaServer(api, session);
    logger.debug(`[START] Aha MCP server started at ${ahaServer.url}`);
    const bridgeCommand = join(projectPath(), 'bin', 'aha-mcp.mjs');
    const mcpServers: Record<string, { command: string; args: string[] }> = {
        aha: {
            command: bridgeCommand,
            args: ['--url', ahaServer.url]
        }
    };
    if (desktopMcpUrl) {
        mcpServers['aha-desktop'] = {
            command: bridgeCommand,
            args: ['--url', desktopMcpUrl]
        };
    }
    const ahaRoomIdEnv = process.env.AHA_ROOM_ID;
    const ahaRoleLabelEnv = process.env.AHA_ROLE_LABEL;
    const ahaMemberIdEnv = process.env.AHA_MEMBER_ID;
    let desktopKanbanInstructionBlock: string | null = null;
    if (desktopMcpUrl && ahaRoomIdEnv) {
        try {
            desktopKanbanInstructionBlock = await buildKanbanInstructionBlock({
                desktopMcpUrl,
                roomId: ahaRoomIdEnv,
                roleId: process.env.AHA_AGENT_ROLE,
                roleLabel: ahaRoleLabelEnv,
                memberId: ahaMemberIdEnv
            });
        } catch (error) {
            logger.debug('[Codex] Failed to prepare Kanban instruction block', error);
        }
    }

    // ============================================================
    // Team Collaboration Initialization
    // ============================================================
    const teamId = metadata.teamId || metadata.roomId;
    const role = metadata.role;
    let taskStateManager: TaskStateManager | undefined;
    let statusReporter: StatusReporter | undefined;
    let teamStorage: TeamMessageStorage | undefined;
    let teamInitialized = false;
    let teamContextBlock: string | null = null;

    if (teamId && role) {
        logger.debug(`[Codex] Team mode detected: teamId=${teamId}, role=${role}`);

        try {
            // Initialize TaskStateManager
            taskStateManager = new TaskStateManager(api, teamId, response.id, role);
            logger.debug(`[Codex] TaskStateManager initialized for role ${role}`);

            // Set up state change notifications
            taskStateManager.setOnStateChange((change) => {
                logger.debug(`[Codex] Kanban state change: ${change.type} - ${change.taskTitle}`);
            });

            // Initialize StatusReporter for automatic status updates
            statusReporter = createStatusReporter(api, taskStateManager, teamId, response.id, role);
            logger.debug(`[Codex] StatusReporter initialized for role ${role}`);

            // Initialize team message storage
            teamStorage = new TeamMessageStorage(process.cwd());

            // Get role metadata
            const roleTitle = getRoleTitle(role) || role;
            const roleResponsibilities = getRoleResponsibilities(role) || [];
            const isCoordinator = COORDINATION_ROLES.includes(role);

            // Send handshake message to announce presence
            let introContent: string;
            if (isCoordinator) {
                introContent = `🎯 **${roleTitle}** online and ready to coordinate!

As the team coordinator, I will:
1. Analyze incoming requests and create execution plans
2. Break down work into actionable tasks
3. Assign tasks to team members

📢 **Team Members:** Please report your status and availability. I will begin task assignment shortly.`;
            } else {
                const responsibilitiesText = roleResponsibilities.length > 0
                    ? roleResponsibilities.map((r, i) => `${i + 1}. ${r}`).join('\n')
                    : 'Ready to assist the team';

                introContent = `✅ **${roleTitle}** online and ready!

**My Capabilities:**
${responsibilitiesText}

Awaiting task assignment from @master or @orchestrator.`;
            }

            // Send handshake message
            const handshakeMsg = {
                id: randomUUID(),
                teamId,
                content: introContent,
                type: 'chat' as const,
                timestamp: Date.now(),
                fromSessionId: response.id,
                fromRole: role,
                metadata: { type: 'handshake', roleTitle }
            };
            await api.sendTeamMessage(teamId, handshakeMsg);
            logger.debug(`[Codex] Sent handshake message to team`);
            console.log(`[Team] 📢 ${roleTitle} announced presence in team chat`);

            // Fetch team context (artifact + recent messages)
            let teamData: any = null;
            let teamName = 'Team';
            let historyText = '(No recent history)';

            try {
                const artifact = await api.getArtifact(teamId);
                teamData = artifact.body;
                teamName = typeof artifact.header === 'object' && artifact.header?.name
                    ? artifact.header.name
                    : 'Team';
                logger.debug('[Codex] Successfully fetched team artifact');
            } catch (e) {
                logger.debug('[Codex] Team artifact not available (this is OK for new teams):', e);
            }

            // Get recent messages for context
            try {
                const recentMessages = await teamStorage.getRecentContext(teamId, 20);
                if (recentMessages && recentMessages.length > 0) {
                    historyText = recentMessages.map((m: any) =>
                        `[${m.fromRole || 'unknown'}] ${m.content?.substring(0, 100)}...`
                    ).join('\n');
                }
            } catch (e) {
                logger.debug('[Codex] Failed to get recent messages:', e);
            }

            // Get kanban context
            let kanbanContextText = '';
            try {
                const kanbanContext = await taskStateManager.getFilteredContext();
                const myTasks = kanbanContext.myTasks || [];
                const availableTasks = kanbanContext.availableTasks || [];
                const stats = kanbanContext.teamStats;

                kanbanContextText = `
## Current Kanban State
- TODO: ${stats.todo} | In Progress: ${stats.inProgress} | Review: ${stats.review} | Done: ${stats.done}
${myTasks.length > 0 ? `\n### My Assigned Tasks:\n${myTasks.map(t => `- [${t.status}] ${t.title}`).join('\n')}` : ''}
${availableTasks.length > 0 ? `\n### Available Tasks:\n${availableTasks.map(t => `- [${t.priority || 'medium'}] ${t.title}`).join('\n')}` : ''}
${isCoordinator && kanbanContext.pendingApprovals?.length ? `\n### Pending Approvals:\n${kanbanContext.pendingApprovals.map(t => `- ${t.title}`).join('\n')}` : ''}`;
            } catch (e) {
                logger.debug('[Codex] Failed to get kanban context:', e);
            }

            // Build team context block for injection into prompt
            teamContextBlock = trimIdent(`
# Team Context for ${roleTitle}

## Your Role
You are **${roleTitle}** in team "${teamName}".
${roleResponsibilities.length > 0 ? `\n**Responsibilities:**\n${roleResponsibilities.map(r => `- ${r}`).join('\n')}` : ''}

${kanbanContextText}

## Recent Team Activity
${historyText}

## Required Actions on Startup
${isCoordinator ? `
1. Call \`get_team_info\` to see full team roster and their status
2. Call \`list_tasks\` to review current kanban state
3. Send a MASTER STATUS REPORT to the team with current situation
4. If there are pending tasks, begin assigning or working on them
5. If no tasks, ask the user what they want the team to work on
` : `
1. Call \`get_team_info\` to understand your team and role
2. Call \`list_tasks\` to see your assigned tasks and available work
3. Report your status: "🟢 [${role.toUpperCase()}] Online and ready"
4. If you have assigned tasks, begin working on them
5. If no tasks, wait for assignment from Master
`}
`);

            teamInitialized = true;
            logger.debug('[Codex] Team initialization complete');

        } catch (e) {
            logger.debug('[Codex] Team initialization failed:', e);
            console.log(`[Team] ⚠️ Failed to initialize team mode: ${e}`);
        }
    }

    let first = true;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');
        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        // If we restart (e.g., mode change), use this to carry a resume file
        let nextExperimentalResume: string | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            // Get next batch; respect mode boundaries like Claude
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            // If a session exists and mode changed, restart on next iteration
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                // Capture previous sessionId and try to find its transcript to resume
                try {
                    const prevSessionId = client.getSessionId();
                    nextExperimentalResume = findCodexResumeFile(prevSessionId);
                    if (nextExperimentalResume) {
                        logger.debug(`[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    } else {
                        logger.debug('[Codex] No resume file found for previous session');
                    }
                } catch (e) {
                    logger.debug('[Codex] Error while searching resume file', e);
                }
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                // Reset processors/permissions like end-of-turn cleanup
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                continue;
            }

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                // Map permission mode to approval policy and sandbox for startSession
                const approvalPolicy = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'untrusted' as const;
                        case 'read-only': return 'never' as const;
                        case 'safe-yolo': return 'on-failure' as const;
                        case 'yolo': return 'on-failure' as const;
                    }
                })();
                const sandbox = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'workspace-write' as const;
                        case 'read-only': return 'read-only' as const;
                        case 'safe-yolo': return 'workspace-write' as const;
                        case 'yolo': return 'danger-full-access' as const;
                    }
                })();

                if (!wasCreated) {
                    const startConfig: CodexSessionConfig = {
                        prompt: first ? message.message + '\n\n' + trimIdent(`Based on this message, call functions.aha__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`) : message.message,
                        sandbox,
                        'approval-policy': approvalPolicy,
                        config: { mcp_servers: mcpServers }
                    };

                    const instructionBlocks: string[] = [];

                    // Inject team context if initialized (this includes role, responsibilities, kanban state, required actions)
                    if (teamInitialized && teamContextBlock) {
                        instructionBlocks.push(teamContextBlock);
                    } else if (metadata.role) {
                        // Fallback: basic role instruction if team initialization failed
                        instructionBlocks.push(
                            `You are a ${metadata.role} in a collaborative team. Coordinate with other agents via the shared Kanban board and keep task statuses accurate.`
                        );
                    }

                    if (desktopKanbanInstructionBlock) {
                        instructionBlocks.push(desktopKanbanInstructionBlock);
                    } else if (!teamInitialized && (metadata.role || metadata.teamId || metadata.roomId)) {
                        // No desktop MCP context AND team initialization failed
                        // Instruct the agent to fetch team info via Aha MCP server
                        instructionBlocks.push(
                            trimIdent(`IMPORTANT: You are part of a team but don't have full team context yet.
Before starting any work, you MUST call the get_team_info tool from the "aha" MCP server to:
1. Understand your role and responsibilities
2. See who else is on the team
3. Learn the communication and workflow protocols

Call functions.aha__get_team_info immediately as your first action.`)
                        );
                    }
                    if (desktopMcpUrl) {
                        instructionBlocks.push(
                            trimIdent(`The desktop has exposed a Kanban MCP server named "aha-desktop".
- Use kanban_list_rooms to see available rooms.
- Use kanban_get_room_state to inspect tasks for the active room.
- Use kanban_create_task / kanban_update_task / kanban_assign_member to manage the board.
Always reflect progress on the board and call these tools whenever you start or finish work.`)
                        );
                    }
                    if (instructionBlocks.length > 0) {
                        startConfig['base-instructions'] = instructionBlocks.join('\n\n');
                    }
                    if (message.mode.model) {
                        startConfig.model = message.mode.model;
                    }

                    // Check for resume file from multiple sources
                    let resumeFile: string | null = null;

                    // Priority 1: Explicit resume file from mode change
                    if (nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null; // consume once
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    }
                    // Priority 2: Resume from stored abort session
                    else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null; // consume once
                    }

                    // Apply resume file if found
                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }

                    await client.startSession(
                        startConfig,
                        { signal: abortController.signal }
                    );
                    wasCreated = true;
                    first = false;
                } else {
                    const response = await client.continueSession(
                        message.message,
                        { signal: abortController.signal }
                    );
                    logger.debug('[Codex] continueSession response:', response);
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    // Session was already stored in handleAbort(), no need to store again
                    // Mark session as not created to force proper resume on next message
                    wasCreated = false;
                    currentModeHash = null;
                    logger.debug('[Codex] Marked session as not created after abort for proper resume');
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    // For unexpected exits, try to store session for potential recovery
                    if (client.hasActiveSession()) {
                        storedSessionIdForResume = client.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');
        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Aha MCP server
        logger.debug('[codex]: ahaServer.stop');
        ahaServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
