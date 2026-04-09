import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexMcpClient, detectCodexCliVersion, parseCodexApprovalRequest } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import type { AgentState, Metadata, UpdateArtifactBody } from '@/api/types';
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
import { filterMaterializedMcpServers, readMaterializedMcpServerNames } from '@/agentDocker/runtimeConfig';
// Team collaboration imports
import { TaskStateManager } from '@/claude/utils/taskStateManager';
import { StatusReporter, createStatusReporter } from '@/claude/team/statusReporter';
import { ensureCurrentSessionRegisteredToTeam } from '@/claude/team/ensureTeamMembership';
import { buildAgentHandshakeContent, COORDINATION_ROLES, generateRolePrompt } from '@/claude/team/roles';
import { TeamMessageStorage } from '@/claude/team/teamMessageStorage';
import { DEFAULT_ROLES } from '@/claude/team/roles.config';
import { fetchAgentImage } from '@/claude/utils/fetchGenome';
import { buildAgentImageInjection } from '@/claude/utils/buildGenomeInjection';
import type { AgentImage } from '@/api/types/genome';
import { buildMountedAgentPrompt } from '@/utils/buildMountedAgentPrompt';
import { buildRuntimeBuildMetadata } from '@/utils/runtimeBuild';
import { CODEX_BRIDGE_DEBUG_ENV, isCodexBridgeDebugEnabled, logCodexBridge, logCodexSignal } from './utils/bridgeDebug';
import { buildCodexRuntimeMetadata } from './runtimeMetadata';
import {
    materializeAgentImageSkillsToCodexHome,
    seedCodexHomeConfig,
    seedCodexHomeSkillUnion,
} from './codexHome';
import { findCodexTranscriptFile, findMostRecentCodexTranscriptFile } from '@/claude/utils/runtimeLogReader';

// Helper functions for role metadata — agent-image-first, empty fallback
function getRoleTitle(roleId: string): string {
    return DEFAULT_ROLES[roleId]?.name || roleId;
}

function getRoleResponsibilities(roleId: string): string[] {
    return DEFAULT_ROLES[roleId]?.responsibilities || [];
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


export function unwrapCodexEvent(rawMessage: any): any {
    if (
        rawMessage &&
        typeof rawMessage === 'object' &&
        rawMessage.type === 'raw_response_item' &&
        rawMessage.item &&
        typeof rawMessage.item === 'object'
    ) {
        return rawMessage.item;
    }
    if (
        rawMessage &&
        typeof rawMessage === 'object' &&
        (rawMessage.type === 'event_msg' || rawMessage.type === 'response_item') &&
        rawMessage.payload &&
        typeof rawMessage.payload === 'object'
    ) {
        return rawMessage.payload;
    }
    return rawMessage;
}

function parseStructuredCodexValue(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return value;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}

function decodeCodexDeltaChunk(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        return '';
    }

    try {
        return Buffer.from(value, 'base64').toString('utf-8');
    } catch {
        return value;
    }
}

function isMcpFunctionName(name: unknown): name is string {
    return typeof name === 'string' && name.startsWith('mcp__');
}

export function convertCodexFunctionEventToSessionMessage(rawMessage: any):
    | {
        type: 'tool-call';
        name: string;
        callId: string;
        input: unknown;
        id: string;
    }
    | {
        type: 'tool-call-result';
        callId: string;
        output: unknown;
        id: string;
    }
    | null {
    const message = unwrapCodexEvent(rawMessage);

    if (!message || typeof message !== 'object') {
        return null;
    }

    if (message.type === 'function_call' && typeof message.name === 'string' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call',
            name: message.name,
            callId: message.call_id,
            input: parseStructuredCodexValue(message.arguments),
            id: randomUUID()
        };
    }

    if (message.type === 'function_call_output' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call-result',
            callId: message.call_id,
            output: parseStructuredCodexValue(message.output),
            id: randomUUID()
        };
    }

    if (message.type === 'custom_tool_call' && typeof message.name === 'string' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call',
            name: message.name,
            callId: message.call_id,
            input: parseStructuredCodexValue(message.input),
            id: randomUUID()
        };
    }

    if (message.type === 'custom_tool_call_output' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call-result',
            callId: message.call_id,
            output: parseStructuredCodexValue(message.output),
            id: randomUUID()
        };
    }

    return null;
}

export function convertCodexMcpLifecycleEventToSessionMessage(rawMessage: any):
    | {
        type: 'tool-call';
        name: string;
        callId: string;
        input: unknown;
        id: string;
    }
    | {
        type: 'tool-call-result';
        callId: string;
        output: unknown;
        id: string;
    }
    | null {
    const message = unwrapCodexEvent(rawMessage);

    if (!message || typeof message !== 'object') {
        return null;
    }

    if (message.type === 'mcp_tool_call_begin' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call',
            name: message.invocation?.tool || 'unknown',
            callId: message.call_id,
            input: message.invocation?.arguments,
            id: randomUUID(),
        };
    }

    if (message.type === 'mcp_tool_call_end' && typeof message.call_id === 'string') {
        const ok = message.result?.Ok;
        const err = message.result?.Err;
        const output = ok ?? err ?? message.result;

        return {
            type: 'tool-call-result',
            callId: message.call_id,
            output,
            id: randomUUID(),
        };
    }

    return null;
}

export function convertCodexApprovalEventToSessionMessage(rawMessage: any):
    | {
        type: 'tool-call';
        name: string;
        callId: string;
        input: unknown;
        id: string;
    }
    | null {
    const message = unwrapCodexEvent(rawMessage);
    if (!message || typeof message !== 'object' || message.type !== 'elicitation_request') {
        return null;
    }

    const approvalRequest = parseCodexApprovalRequest(message);
    if (!approvalRequest) {
        return null;
    }

    return {
        type: 'tool-call',
        name: 'CodexApprovalRequest',
        callId: `approval:${approvalRequest.toolCallId}`,
        input: {
            toolCallId: approvalRequest.toolCallId,
            toolName: approvalRequest.toolName,
            approvalKind: approvalRequest.approvalKind,
            ...approvalRequest.input
        },
        id: randomUUID(),
    };
}

export function convertCodexAssistantEventToSessionMessage(rawMessage: any):
    | {
        type: 'message';
        message: string;
        id: string;
    }
    | {
        type: 'reasoning';
        message: string;
        id: string;
    }
    | null {
    const message = unwrapCodexEvent(rawMessage);

    if (!message || typeof message !== 'object') {
        return null;
    }

    if (message.type === 'item_completed' && message.item?.type === 'AgentMessage' && Array.isArray(message.item.content)) {
        const text = message.item.content
            .filter((item: any) => (item?.type === 'Text' || item?.type === 'output_text') && typeof item.text === 'string')
            .map((item: any) => item.text)
            .join('');

        if (!text.trim()) {
            return null;
        }

        return {
            type: 'message',
            message: text,
            id: randomUUID(),
        };
    }

    if (message.type === 'item_completed' && message.item?.type === 'Reasoning') {
        const summary = Array.isArray(message.item.summary_text)
            ? message.item.summary_text
                .map((item: any) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item.text === 'string') return item.text;
                    if (item && typeof item.summary === 'string') return item.summary;
                    return '';
                })
                .filter(Boolean)
                .join('\n')
            : '';

        if (!summary.trim()) {
            return null;
        }

        return {
            type: 'reasoning',
            message: summary,
            id: randomUUID(),
        };
    }

    if (message.type === 'message' && message.role === 'assistant' && Array.isArray(message.content)) {
        const text = message.content
            .filter((item: any) => item?.type === 'output_text' && typeof item.text === 'string')
            .map((item: any) => item.text)
            .join('');

        if (!text.trim()) {
            return null;
        }

        return {
            type: 'message',
            message: text,
            id: randomUUID(),
        };
    }

    if (message.type === 'reasoning') {
        const summary = Array.isArray(message.summary)
            ? message.summary
                .map((item: any) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item.text === 'string') return item.text;
                    if (item && typeof item.summary === 'string') return item.summary;
                    return '';
                })
                .filter(Boolean)
                .join('\n')
            : '';

        if (!summary.trim()) {
            return null;
        }

        return {
            type: 'reasoning',
            message: summary,
            id: randomUUID(),
        };
    }

    return null;
}

/**
 * Normalize any permission mode string to the unified PermissionMode type.
 * Aha default is always bypassPermissions (highest privilege).
 */
function resolvePermissionMode(rawMode?: string): PermissionMode {
    if (!rawMode) {
        return 'bypassPermissions';
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
            return 'bypassPermissions';
        case 'acceptedits':
            return 'acceptEdits';
        case 'plan':
            return 'plan';
        default:
            logger.debug(`[Codex] Unknown permission mode "${rawMode}", defaulting to bypassPermissions`);
            return 'bypassPermissions';
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
 *
 * Codex bridge compatibility target:
 * - codex-cli 0.117.0
 *
 * The current bridge work is anchored to the event model observed from that version,
 * especially these high-value families:
 * - item_started / item_completed
 * - raw_response_item
 * - mcp_tool_call_begin / mcp_tool_call_end
 * - elicitation_request
 * - exec_command_output_delta
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    sessionTag?: string;
}): Promise<void> {
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
    }

    //
    // Define session
    //

    const sessionTag = opts.sessionTag || randomUUID();
    const codexCliVersion = detectCodexCliVersion();
    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);
    logger.debug(`[codex] Bridge compatibility target active for codex-cli ${codexCliVersion ?? 'unknown'}`);
    logger.debug(`[codex] ${CODEX_BRIDGE_DEBUG_ENV}=${isCodexBridgeDebugEnabled() ? 'enabled' : 'disabled'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    if (!machineId) {
        logger.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/Shiyao-Huang/aha/issues/new/choose`);
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
    const processStartedAt = Date.now();
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
        processStartedAt,
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'codex',
        codexCliVersion: codexCliVersion ?? undefined,
        sessionTag,
        runtimeBuild: buildRuntimeBuildMetadata({
            cwd: process.cwd(),
            runtime: 'codex',
            startedAt: processStartedAt,
        }),
    };
    if (process.env.AHA_TEAM_MEMBER_ID) {
        metadata.memberId = process.env.AHA_TEAM_MEMBER_ID;
    }
    if (process.env.AHA_AGENT_ROLE) {
        metadata.role = process.env.AHA_AGENT_ROLE;
    }
    if (process.env.AHA_CANDIDATE_ID) {
        metadata.candidateId = process.env.AHA_CANDIDATE_ID;
    }
    if (process.env.AHA_SPEC_ID) {
        metadata.specId = process.env.AHA_SPEC_ID;
    }
    if (process.env.AHA_CANDIDATE_IDENTITY_JSON) {
        try {
            metadata.candidateIdentity = JSON.parse(process.env.AHA_CANDIDATE_IDENTITY_JSON);
        } catch {
            // Keep backward-compatible scalar fields if the JSON payload is malformed.
        }
    }
    if (process.env.AHA_ROOM_ID) {
        metadata.teamId = process.env.AHA_ROOM_ID;
        metadata.roomId = process.env.AHA_ROOM_ID;
    }
    if (process.env.AHA_EXECUTION_PLANE) {
        metadata.executionPlane = process.env.AHA_EXECUTION_PLANE as 'bypass' | 'mainline';
    }
    if (process.env.AHA_ROOM_NAME) {
        metadata.roomName = process.env.AHA_ROOM_NAME;
        metadata.name = process.env.AHA_ROOM_NAME;
    }
    if (process.env.AHA_AGENT_MODEL) {
        metadata.modelOverride = process.env.AHA_AGENT_MODEL;
    }
    if (process.env.AHA_FALLBACK_AGENT_MODEL) {
        metadata.fallbackModelOverride = process.env.AHA_FALLBACK_AGENT_MODEL;
    }
    const recoverAhaSessionId = process.env.AHA_RECOVER_SESSION_ID?.trim() || undefined;
    const response = await api.getOrCreateSession({ sessionId: recoverAhaSessionId, tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides to apply per message
    // Aha default: bypassPermissions (highest privilege for both Claude and Codex)
    let currentPermissionMode: PermissionMode = resolvePermissionMode(process.env.AHA_PERMISSION_MODE);
    logger.debug(`[Codex] Permission mode initialized: ${currentPermissionMode}`);
    let currentModel: string | undefined = session.getMetadata()?.modelOverride || process.env.AHA_AGENT_MODEL || undefined;

    const syncRuntimePermissionMetadata = () => {
        void session.updateMetadata((currentMetadata) => buildCodexRuntimeMetadata(currentMetadata, {
            permissionMode: currentPermissionMode,
        })).catch((error) => {
            logger.debug('[Codex] Failed to sync runtime permission metadata:', error);
        });
    };

    syncRuntimePermissionMetadata();

    const getCurrentEnhancedMode = (): EnhancedMode => ({
        permissionMode: currentPermissionMode,
        model: currentModel,
    });

    session.on('artifact-update', (update: UpdateArtifactBody) => {
        logger.debug('[Codex] Received artifact update, forwarding to agent');
        client.sendArtifactUpdate(update);
    });

    session.on('team-message', (message: any) => {
        const activeTeamId = metadata.teamId || metadata.roomId;
        // CRITICAL: Filter by teamId to prevent cross-team message leakage
        if (!activeTeamId || message.teamId !== activeTeamId) {
            logger.debug(`[Codex] Ignoring message from other team: ${message.teamId} !== ${activeTeamId}`);
            return;
        }
        logger.debug('[Codex] Received team message, injecting as user message');
        const senderLabel = message.fromDisplayName || message.fromRole || message.fromSessionId || 'Unknown';
        if (message.fromSessionId === session.sessionId) return;

        const content = message.content || JSON.stringify(message);
        const formattedMessage = `[Team Message from ${senderLabel}]: ${content}`;

        messageQueue.push(formattedMessage, getCurrentEnhancedMode());
    });

    session.on('metadata-update', async (newMetadata: Metadata) => {
        logger.debug('[Codex] Session metadata updated', newMetadata);
        const previousRole = metadata.role;
        const previousTeamId = metadata.teamId || metadata.roomId;

        if (newMetadata.role) {
            metadata.role = newMetadata.role;
        }
        if (newMetadata.teamId) {
            metadata.teamId = newMetadata.teamId;
        }
        if (newMetadata.roomId) {
            metadata.roomId = newMetadata.roomId;
        }
        if (newMetadata.roomName) {
            metadata.roomName = newMetadata.roomName;
            metadata.name = newMetadata.roomName;
        }
        if (newMetadata.modelOverride !== undefined) {
            currentModel = newMetadata.modelOverride || undefined;
            logger.debug(`[Codex] Model override updated from metadata: ${currentModel || 'default'}`);
        }

        const nextRole = metadata.role;
        const nextTeamId = metadata.teamId || metadata.roomId;
        const roleChanged = !!nextRole && nextRole !== previousRole;
        const teamChanged = !!nextTeamId && nextTeamId !== previousTeamId;

        if (roleChanged || teamChanged) {
            const updates: string[] = [];
            if (teamChanged) {
                updates.push(`You have joined team ${nextTeamId}.`);
            }
            if (roleChanged) {
                updates.push(`Your role is now ${nextRole}.`);
            }
            updates.push('Call functions.aha__get_team_info immediately to load the latest team context, roster, and workflow rules.');
            messageQueue.push(`[System]: ${updates.join(' ')}`, getCurrentEnhancedMode());
            teamInitialized = false;

            // Rebuild team context block so next session start injects updated context
            // (mirrors Claude branch behavior in updateTeamHandling)
            if (nextTeamId && nextRole && taskStateManager) {
                try {
                    const kanbanCtx = await taskStateManager.getFilteredContext();
                    const sessionMetadataForRebuild = {
                        ...(session.getMetadata() || {}),
                        teamId: nextTeamId,
                        role: nextRole,
                    } as Metadata;
                    const rebuiltRolePrompt = generateRolePrompt(
                        sessionMetadataForRebuild,
                        kanbanCtx,
                        agentImage ?? undefined
                    );
                    teamContextBlock = rebuiltRolePrompt;
                    teamInitialized = true;
                    logger.debug('[Codex] Rebuilt teamContextBlock after metadata-update');
                } catch (e) {
                    logger.debug('[Codex] Failed to rebuild teamContextBlock:', e);
                    teamContextBlock = null;
                }
            } else {
                teamContextBlock = null;
            }
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
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = resolvePermissionMode(message.meta.permissionMode);
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            syncRuntimePermissionMetadata();
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode,
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
            // NOTE: Do NOT call messageQueue.reset() here — it would drop queued user messages.
            // permissionHandler/reasoningProcessor/diffProcessor are reset in the finally block.
            reasoningProcessor.abort();
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

            // Force close Codex MCP transport so the codex subprocess doesn't linger
            try {
                await client.forceCloseSession();
            } catch (e) {
                logger.debug('[Codex] Error while force closing Codex session during termination', e);
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
    const permissionHandler = new CodexPermissionHandler(session, () => currentPermissionMode);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    client.setPermissionHandler(permissionHandler);

    // Accumulator for agent_message_delta events.
    // Newer Codex SDK versions stream text via agent_message_delta and only
    // emit agent_message with a short summary (e.g. title update).  We
    // accumulate the deltas so we can forward the full text to kanban.
    let agentMessageDeltaBuffer = '';
    const mcpLifecycleCallIds = new Set<string>();
    const suppressedAhaTitleCallIds = new Set<string>();
    const execOutputBuffers = new Map<string, { stdout: string; stderr: string }>();

    client.setHandler((rawMsg) => {
        const msg = unwrapCodexEvent(rawMsg);
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);
        logCodexBridge('Inbound codex/event payload', rawMsg);
        logCodexSignal('received', msg, {
            rawSignalType: rawMsg && typeof rawMsg === 'object' && 'type' in (rawMsg as Record<string, unknown>)
                ? (rawMsg as Record<string, unknown>).type
                : null
        });

        // Do not infer metadata.tools from bridge registry or mcp server config.
        // Only a runtime event that explicitly surfaces the final tool inventory to Codex
        // is allowed to populate visible-tool truth. No such event is currently known here.

        // item_completed events duplicate content already delivered via agent_message / agent_reasoning.
        // Skip them entirely to prevent 2-3x message repetition in context.
        if (msg.type === 'item_completed') {
            logCodexSignal('skipped', msg, {
                reason: 'item_completed duplicates already-forwarded content'
            });
            return;
        }

        // session_meta: capture Codex's internal session UUID to resolve the transcript file path.
        // The aha session ID (CUID) does not match the Codex internal UUID (UUIDv7) used in
        // transcript filenames. Storing the resolved path in metadata enables get_context_status
        // to locate the correct transcript without a UUID mismatch.
        if (msg.type === 'session_meta') {
            const codexInternalId = (msg as any)?.id ?? (msg as any)?.payload?.id;
            if (typeof codexInternalId === 'string' && codexInternalId.length > 0) {
                const homeDir = process.env.HOME || os.homedir();
                const resolvedPath = findCodexTranscriptFile(homeDir, codexInternalId)
                    ?? findMostRecentCodexTranscriptFile(homeDir);
                if (resolvedPath) {
                    void session.updateMetadata((current) => ({
                        ...current,
                        codexTranscriptPath: resolvedPath,
                    })).catch((err) => {
                        logger.debug('[Codex] Failed to store codexTranscriptPath in metadata:', err);
                    });
                }
            }
            return;
        }

        const approvalMessage = convertCodexApprovalEventToSessionMessage(msg);
        if (approvalMessage) {
            messageBuffer.addMessage(`Approval required: ${String((approvalMessage.input as Record<string, unknown>).toolName || 'unknown')}`, 'tool');
            logCodexBridge('Observed approval event; relying on agentState permission flow instead of synthetic session message', approvalMessage);
            logCodexSignal('observed-approval', msg, {
                sessionMessage: approvalMessage
            });
            return;
        }

        // Old-format Codex events: `message` (role: assistant) and `reasoning` type.
        // These are only emitted by older Codex versions that don't send agent_message/agent_reasoning.
        const assistantMessage = convertCodexAssistantEventToSessionMessage(msg);
        if (assistantMessage && msg.type !== 'agent_message' && msg.type !== 'agent_reasoning') {
            const fullText = assistantMessage.type === 'message'
                ? (agentMessageDeltaBuffer || assistantMessage.message)
                : assistantMessage.message;
            agentMessageDeltaBuffer = '';

            if (assistantMessage.type === 'message') {
                messageBuffer.addMessage(fullText, 'assistant');
            } else {
                messageBuffer.addMessage(`[Thinking] ${fullText.substring(0, 100)}...`, 'system');
            }

            const sessionMessage = {
                ...assistantMessage,
                message: fullText,
            };
            session.sendCodexMessage(sessionMessage);
            logCodexSignal('forwarded-assistant', msg, {
                sessionMessage,
                fullTextLength: fullText.length
            });
            return;
        }

        const mcpLifecycleMessage = convertCodexMcpLifecycleEventToSessionMessage(msg);
        if (mcpLifecycleMessage) {
            if (msg.type === 'mcp_tool_call_begin'
                && msg.invocation?.server === 'aha'
                && msg.invocation?.tool === 'change_title'
                && mcpLifecycleMessage.type === 'tool-call') {
                suppressedAhaTitleCallIds.add(mcpLifecycleMessage.callId);
                logCodexSignal('suppressed-mcp-lifecycle', msg, {
                    reason: 'aha change_title should render via summary/title update, not raw tool card',
                    sessionMessage: mcpLifecycleMessage
                });
                return;
            }
            if (mcpLifecycleMessage.type === 'tool-call-result' && suppressedAhaTitleCallIds.has(mcpLifecycleMessage.callId)) {
                suppressedAhaTitleCallIds.delete(mcpLifecycleMessage.callId);
                logCodexSignal('suppressed-mcp-lifecycle', msg, {
                    reason: 'aha change_title result suppressed with paired begin event',
                    sessionMessage: mcpLifecycleMessage
                });
                return;
            }
            if (mcpLifecycleMessage.type === 'tool-call') {
                mcpLifecycleCallIds.add(mcpLifecycleMessage.callId);
                messageBuffer.addMessage(`Tool: ${mcpLifecycleMessage.name}`, 'tool');
            }
            session.sendCodexMessage(mcpLifecycleMessage);
            logCodexBridge('Forwarded MCP lifecycle event to session', mcpLifecycleMessage);
            logCodexSignal('forwarded-mcp-lifecycle', msg, {
                sessionMessage: mcpLifecycleMessage
            });
            return;
        }

        // Accumulate streaming text deltas
        if (msg.type === 'agent_message_delta') {
            agentMessageDeltaBuffer += msg.delta;
            logCodexSignal('buffered-agent-message-delta', msg, {
                bufferLength: agentMessageDeltaBuffer.length
            });
            return; // Don't process further — wait for agent_message or task_complete
        }
        // agent_message_content_delta is a duplicate of agent_message_delta with extra metadata — skip
        if (msg.type === 'agent_message_content_delta') {
            logCodexSignal('skipped', msg, {
                reason: 'agent_message_content_delta duplicates agent_message_delta'
            });
            return;
        }
        if (msg.type === 'exec_command_output_delta') {
            const buffer = execOutputBuffers.get(msg.call_id) || { stdout: '', stderr: '' };
            const decoded = decodeCodexDeltaChunk(msg.chunk);
            if (msg.stream === 'stderr') {
                buffer.stderr += decoded;
            } else {
                buffer.stdout += decoded;
            }
            execOutputBuffers.set(msg.call_id, buffer);
            logCodexSignal('buffered-exec-output-delta', msg, {
                stdoutLength: buffer.stdout.length,
                stderrLength: buffer.stderr.length
            });
            return;
        }

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            // NOTE: Do NOT clear agentMessageDeltaBuffer here — it is read and cleared
            // in the session send block below to avoid double-read/premature clear.
            const fullText = agentMessageDeltaBuffer || msg.message;
            messageBuffer.addMessage(fullText, 'assistant');
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
            logCodexSignal('updated-thinking-state', msg, {
                thinking
            });
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Flush any remaining delta text that wasn't closed by agent_message
            let flushedDeltaLength = 0;
            if (agentMessageDeltaBuffer) {
                flushedDeltaLength = agentMessageDeltaBuffer.length;
                const sessionMessage = {
                    type: 'message',
                    message: agentMessageDeltaBuffer,
                    id: randomUUID()
                };
                session.sendCodexMessage(sessionMessage);
                agentMessageDeltaBuffer = '';
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
            logCodexSignal('task-finished-cleanup', msg, {
                thinking,
                flushedDeltaLength,
                diffProcessorReset: true
            });
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
            logCodexSignal('processed-reasoning-section-break', msg);
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
            logCodexSignal('processed-reasoning-delta', msg, {
                deltaLength: msg.delta.length
            });
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
            logCodexSignal('processed-reasoning-complete', msg, {
                textLength: msg.text.length
            });
        }
        if (msg.type === 'agent_message') {
            // Use accumulated delta text when available; fall back to msg.message for older SDK
            const fullText = agentMessageDeltaBuffer || msg.message;
            agentMessageDeltaBuffer = '';
            const sessionMessage = {
                type: 'message',
                message: fullText,
                id: randomUUID()
            };
            session.sendCodexMessage(sessionMessage);
            logCodexSignal('forwarded-agent-message', msg, {
                sessionMessage,
                fullTextLength: fullText.length
            });
        }
        const functionToolMessage = convertCodexFunctionEventToSessionMessage(msg);
        if (functionToolMessage) {
            if (functionToolMessage.type === 'tool-call' && isMcpFunctionName(functionToolMessage.name)) {
                logCodexSignal('suppressed-function-event', msg, {
                    reason: 'raw MCP function_call suppressed in favor of lifecycle events',
                    sessionMessage: functionToolMessage
                });
                return;
            }
            if (functionToolMessage.type === 'tool-call-result' && mcpLifecycleCallIds.has(functionToolMessage.callId)) {
                logCodexSignal('suppressed-function-event', msg, {
                    reason: 'raw MCP function_call_output suppressed because lifecycle event already handled it',
                    sessionMessage: functionToolMessage
                });
                return;
            }
            if (functionToolMessage.type === 'tool-call') {
                messageBuffer.addMessage(`Tool: ${functionToolMessage.name}`, 'tool');
            }
            session.sendCodexMessage(functionToolMessage);
            logCodexBridge('Forwarded function event to session', functionToolMessage);
            logCodexSignal('forwarded-function-event', msg, {
                sessionMessage: functionToolMessage
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            let { call_id, type, ...inputs } = msg;
            const sessionMessage = {
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            } as const;
            session.sendCodexMessage(sessionMessage);
            logCodexBridge('Forwarded exec event to session', sessionMessage);
            logCodexSignal('forwarded-exec-event', msg, {
                sessionMessage
            });
        }
        if (msg.type === 'exec_command_end') {
            let { call_id, type, ...output } = msg;
            const buffered = execOutputBuffers.get(call_id);
            if (buffered) {
                output = {
                    ...output,
                    stdout: typeof output.stdout === 'string' && output.stdout.length > 0 ? output.stdout : buffered.stdout,
                    stderr: typeof output.stderr === 'string' && output.stderr.length > 0 ? output.stderr : buffered.stderr,
                };
                execOutputBuffers.delete(call_id);
            }
            const sessionMessage = {
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            } as const;
            session.sendCodexMessage(sessionMessage);
            logCodexBridge('Forwarded exec result to session', sessionMessage);
            logCodexSignal('forwarded-exec-result', msg, {
                sessionMessage
            });
        }
        if (msg.type === 'token_count') {
            const sessionMessage = {
                ...msg,
                id: randomUUID()
            };
            session.sendCodexMessage(sessionMessage);
            logCodexSignal('forwarded-token-count', msg, {
                sessionMessage
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
            const sessionMessage = {
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            };
            session.sendCodexMessage(sessionMessage);
            logCodexSignal('forwarded-patch-begin', msg, {
                sessionMessage,
                changeCount
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
            const sessionMessage = {
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            };
            session.sendCodexMessage(sessionMessage);
            logCodexSignal('forwarded-patch-end', msg, {
                sessionMessage
            });
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
            logCodexSignal('processed-turn-diff', msg, {
                diffLength: typeof msg.unified_diff === 'string' ? msg.unified_diff.length : 0
            });
        }
    });

    // Start Aha MCP server
    const desktopMcpUrl = process.env.AHA_DESKTOP_MCP_URL;
    const ahaServer = await startAhaServer(api, session);
    logger.debug(`[START] Aha MCP server started at ${ahaServer.url}`);
    const bridgeCommand = join(projectPath(), 'bin', 'aha-mcp.mjs');
    const allowedMaterializedMcpServerNames = process.env.AHA_AGENT_MCP_CONFIG_PATH
        ? readMaterializedMcpServerNames(process.env.AHA_AGENT_MCP_CONFIG_PATH)
        : [];
    const availableMcpServers: Record<string, { type: string; command: string; args: string[] }> = {
        aha: {
            type: 'stdio',
            command: bridgeCommand,
            args: ['--url', ahaServer.url]
        }
    };
    if (desktopMcpUrl) {
        availableMcpServers['aha-desktop'] = {
            type: 'stdio',
            command: bridgeCommand,
            args: ['--url', desktopMcpUrl]
        };
    }
    const mcpServers = filterMaterializedMcpServers(availableMcpServers, allowedMaterializedMcpServerNames);
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
    // AgentImage — fetch and build injection text
    // ============================================================
    let agentImageInjectionBlock: string | null = null;
    let agentImage: AgentImage | null = null;
    const agentImageId = process.env.AHA_SPEC_ID;
    if (agentImageId) {
        try {
            agentImage = await fetchAgentImage(opts.credentials.token, agentImageId);
            const injection = buildAgentImageInjection(agentImage);
            if (injection) {
                agentImageInjectionBlock = injection;
                logger.debug(`[Codex] AgentImage injection built for spec ${agentImageId}`);
            }
        } catch (error) {
            if (process.env.AHA_GENOME_FALLBACK !== '1') {
                logger.debug(`[Codex] Failed to load agent image (specId=${agentImageId}): ${error}`);
            }
        }
    }
    const sourceCodexEnv = { ...process.env };
    const materializedCommandsDir = process.env.AHA_AGENT_COMMANDS_DIR;
    if ((materializedCommandsDir || agentImage) && !process.env.CODEX_HOME) {
        const isolatedCodexHome = fs.mkdtempSync(join(os.tmpdir(), 'aha-codex-home-'));
        seedCodexHomeConfig(isolatedCodexHome, { env: sourceCodexEnv });
        process.env.CODEX_HOME = isolatedCodexHome;
        logger.debug(`[Codex] Created isolated CODEX_HOME at ${isolatedCodexHome} for runtime skill overlay`);
    }

    const effectiveCodexHome = process.env.CODEX_HOME || join(os.homedir(), '.codex');
    if (materializedCommandsDir) {
        seedCodexHomeSkillUnion(effectiveCodexHome, {
            commandsDir: materializedCommandsDir,
            env: sourceCodexEnv,
        });
    }
    if (agentImage) {
        const warnings = materializeAgentImageSkillsToCodexHome(effectiveCodexHome, {
            agentImage,
            runtimeLibRoot: join(configuration.ahaHomeDir, 'runtime-lib'),
            repoRoot: process.cwd(),
            env: sourceCodexEnv,
        });
        for (const warning of warnings) {
            logger.debug(`[Codex] ${warning}`);
        }
    }
    const mountedAgentPromptBlock = buildMountedAgentPrompt(process.env.AHA_AGENT_PROMPT) ?? null;

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
            taskStateManager = new TaskStateManager(api, teamId, response.id, role, metadata);
            logger.debug(`[Codex] TaskStateManager initialized for role ${role}`);

            // Set up state change notifications
            taskStateManager.setOnStateChange((change) => {
                logger.debug(`[Codex] Kanban state change: ${change.type} - ${change.taskTitle}`);
            });

            // Initialize StatusReporter for automatic status updates
            statusReporter = createStatusReporter(api, taskStateManager, teamId, response.id, role);
            logger.debug(`[Codex] StatusReporter initialized for role ${role}`);

            const membershipResult = await ensureCurrentSessionRegisteredToTeam({
                api,
                teamId,
                sessionId: response.id,
                role,
                metadata,
                taskStateManager,
            });
            logger.debug(
                `[Codex] Team membership sync result: registered=${membershipResult.registered}, alreadyPresent=${membershipResult.alreadyPresent}`
            );

            // Initialize team message storage
            teamStorage = new TeamMessageStorage(process.cwd());

            // Get role metadata
            const roleTitle = getRoleTitle(role) || role;
            const roleResponsibilities = getRoleResponsibilities(role) || [];
            const isCoordinator = COORDINATION_ROLES.includes(role);

            // Send handshake message to announce presence
            const introContent = buildAgentHandshakeContent({
                role,
                roleTitle,
                isCoordinator,
                roleDescription: isCoordinator ? `Coordinate the team as ${roleTitle}` : undefined,
                responsibilities: roleResponsibilities,
            });

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
            logger.debug(`[Team] 📢 ${roleTitle} announced presence in team chat`);

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
            let joinKanbanContext: Awaited<ReturnType<TaskStateManager['getFilteredContext']>> | undefined;
            try {
                joinKanbanContext = await taskStateManager.getFilteredContext();
            } catch (e) {
                logger.debug('[Codex] Failed to get kanban context:', e);
            }

            const sessionMetadataForPrompt = {
                ...(session.getMetadata() || {}),
                teamId,
                role,
            } as Metadata;

            const sharedRolePrompt = generateRolePrompt(
                sessionMetadataForPrompt,
                joinKanbanContext,
                agentImage ?? undefined
            );

            const recentTeamActivityBlock = trimIdent(`
## Team Name
${teamName}

## Recent Team Activity
${historyText}
`);

            teamContextBlock = [sharedRolePrompt, recentTeamActivityBlock].join('\n\n');

            teamInitialized = true;
            logger.debug('[Codex] Team initialization complete');

        } catch (e) {
            logger.debug('[Codex] Team initialization failed:', e);
            logger.debug(`[Team] ⚠️ Failed to initialize team mode: ${e}`);
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
                        case 'yolo':
                        case 'bypassPermissions': return 'never' as const;        // Aha full-access modes must not block on Codex approvals
                        case 'acceptEdits': return 'on-request' as const;
                        case 'plan': return 'untrusted' as const;
                        default: return 'on-failure' as const;                    // Unknown → treat as bypass
                    }
                })();
                const sandbox = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'workspace-write' as const;
                        case 'read-only': return 'read-only' as const;
                        case 'safe-yolo': return 'workspace-write' as const;
                        case 'yolo':
                        case 'bypassPermissions': return 'danger-full-access' as const;  // Aha default: full access
                        case 'acceptEdits': return 'workspace-write' as const;
                        case 'plan': return 'workspace-write' as const;
                        default: return 'danger-full-access' as const;                   // Unknown → treat as bypass
                    }
                })();

                if (!wasCreated) {
                    const startConfig: CodexSessionConfig = {
                        prompt: first ? message.message + '\n\n' + trimIdent(`If functions.aha__change_title is available in this session, call it to set a chat title that represents the current task. If the task changes dramatically later and the tool is available, call it again to update the title.`) : message.message,
                        sandbox,
                        'approval-policy': approvalPolicy,
                        config: { mcp_servers: mcpServers }
                    };

                    const instructionBlocks: string[] = [];

                    if (mountedAgentPromptBlock) {
                        instructionBlocks.push(mountedAgentPromptBlock);
                    }

                    // Inject team context if initialized (this includes role, responsibilities, kanban state, required actions)
                    if (teamInitialized && teamContextBlock) {
                        instructionBlocks.push(teamContextBlock);
                    } else if (metadata.role) {
                        // Fallback: basic role instruction if team initialization failed
                        instructionBlocks.push(
                            `You are a ${metadata.role} in a collaborative team. Coordinate with other agents via the shared Kanban board and keep task statuses accurate.`
                        );
                    }

                    // Inject agent-image memory (learnings, patterns, scope, etc.)
                    if (agentImageInjectionBlock && !teamInitialized) {
                        instructionBlocks.push(agentImageInjectionBlock);
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
        logger.debug('[codex]: client.forceCloseSession begin');
        await client.forceCloseSession();
        logger.debug('[codex]: client.forceCloseSession done');
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
