/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { logger } from '@/ui/logger';
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { z } from 'zod';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import { logCodexBridge } from './utils/bridgeDebug';
import { createCodexTransport } from './windowsSafeStdioClientTransport';
import { withWindowsHide } from '@/utils/windowsProcessOptions';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days, which is the half of the maximum possible timeout (~28 days for int32 value in NodeJS)

type CodexApprovalRequest = {
    requestId: string;
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    approvalKind: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractToolNameFromApprovalMessage(message: string | null): string | null {
    if (!message) {
        return null;
    }

    const toolMatch = message.match(/tool\s+"([^"]+)"/i);
    if (toolMatch?.[1]) {
        return toolMatch[1];
    }

    const execMatch = message.match(/run command\s+"([^"]+)"/i);
    return execMatch?.[1] ?? null;
}

function extractToolCallId(requestId: string | null): string | null {
    if (!requestId) {
        return null;
    }

    const approvalPrefix = 'mcp_tool_call_approval_';
    if (requestId.startsWith(approvalPrefix)) {
        return requestId.slice(approvalPrefix.length);
    }

    return requestId;
}

export function parseCodexApprovalRequest(rawRequest: unknown): CodexApprovalRequest | null {
    const root = asObject(rawRequest);
    if (!root) {
        return null;
    }

    const eventRequest = asObject(root.request);
    const params = eventRequest ?? root;
    const meta = asObject(params._meta);

    const requestId =
        asString(root.id) ??
        asString(params.elicitationId) ??
        asString(root.codex_event_id) ??
        asString(root.codex_mcp_tool_call_id) ??
        asString(root.codex_call_id);

    const toolCallId =
        asString(root.codex_call_id) ??
        asString(root.codex_mcp_tool_call_id) ??
        extractToolCallId(requestId);

    const message = asString(params.message);
    const approvalKind =
        asString(meta?.codex_approval_kind) ??
        asString(root.codex_elicitation) ??
        (Array.isArray(root.codex_command) ? 'exec_command' : null);

    if (Array.isArray(root.codex_command)) {
        if (!requestId || !toolCallId) {
            return null;
        }

        return {
            requestId,
            toolCallId,
            toolName: 'CodexBash',
            input: {
                command: root.codex_command,
                cwd: asString(root.codex_cwd),
                message
            },
            approvalKind
        };
    }

    const serverName = asString(root.server_name) ?? asString(root.serverName);
    const parsedToolName = extractToolNameFromApprovalMessage(message);
    const toolName =
        (serverName && parsedToolName)
            ? `mcp__${serverName}__${parsedToolName}`
            : parsedToolName;

    if (!requestId || !toolCallId || !toolName) {
        return null;
    }

    return {
        requestId,
        toolCallId,
        toolName,
        input: {
            server: serverName,
            tool: parsedToolName,
            arguments: meta?.tool_params ?? null,
            toolDescription: asString(meta?.tool_description),
            persist: Array.isArray(meta?.persist) ? meta.persist : null,
            message
        },
        approvalKind
    };
}

function collectIdentifierCandidates(source: unknown): Array<Record<string, unknown>> {
    const root = asObject(source);
    if (!root) {
        return [];
    }

    const candidates: Array<Record<string, unknown>> = [root];
    const nestedKeys = ['data', 'meta', 'structuredContent', 'content', 'item', 'payload'];
    for (const key of nestedKeys) {
        const value = root[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                const obj = asObject(item);
                if (obj) {
                    candidates.push(obj);
                }
            }
            continue;
        }

        const obj = asObject(value);
        if (obj) {
            candidates.push(obj);
        }
    }

    return candidates;
}

function extractThreadId(source: unknown): string | null {
    for (const candidate of collectIdentifierCandidates(source)) {
        const threadId = asString(candidate.threadId) ?? asString(candidate.thread_id);
        if (threadId) {
            return threadId;
        }
    }

    return null;
}

function extractConversationId(source: unknown): string | null {
    for (const candidate of collectIdentifierCandidates(source)) {
        const conversationId = asString(candidate.conversationId) ?? asString(candidate.conversation_id);
        if (conversationId) {
            return conversationId;
        }
    }

    return null;
}

function extractSessionId(source: unknown): string | null {
    for (const candidate of collectIdentifierCandidates(source)) {
        const sessionId = asString(candidate.sessionId) ?? asString(candidate.session_id);
        if (sessionId) {
            return sessionId;
        }
    }

    return null;
}

/**
 * Get the correct MCP subcommand based on installed codex version
 * Versions >= 0.43.0-alpha.5 use 'mcp-server', older versions use 'mcp'
 */
function readCodexVersion(): string {
    return execFileSync('codex', ['--version'], withWindowsHide<ExecFileSyncOptions>({
        encoding: 'utf8' as BufferEncoding,
    })).toString().trim();
}

function getCodexMcpCommand(): string {
    try {
        const version = readCodexVersion();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
        if (!match) return 'mcp-server'; // Default to newer command if we can't parse

        const versionStr = match[1];
        const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

        // Version >= 0.43.0-alpha.5 has mcp-server
        if (major > 0 || minor > 43) return 'mcp-server';
        if (minor === 43 && patch === 0) {
            // Check for alpha version
            if (versionStr.includes('-alpha.')) {
                const alphaNum = parseInt(versionStr.split('-alpha.')[1]);
                return alphaNum >= 5 ? 'mcp-server' : 'mcp';
            }
            return 'mcp-server'; // 0.43.0 stable has mcp-server
        }
        return 'mcp'; // Older versions use mcp
    } catch (error) {
        logger.debug('[CodexMCP] Error detecting codex version, defaulting to mcp-server:', error);
        return 'mcp-server'; // Default to newer command
    }
}

export function detectCodexCliVersion(): string | null {
    try {
        const version = readCodexVersion();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
        return match ? match[1] : null;
    } catch (error) {
        logger.debug('[CodexMCP] Error detecting codex version:', error);
        return null;
    }
}

export class CodexMcpClient {
    private client: Client;
    private transport: ReturnType<typeof createCodexTransport> | null = null;
    private connected: boolean = false;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;

    constructor() {
        this.client = new Client(
            { name: 'aha-codex-client', version: '1.0.0' },
            { capabilities: { tools: {}, elicitation: {} } }
        );

        this.client.setNotificationHandler(z.object({
            method: z.literal('codex/event'),
            params: z.object({
                msg: z.any()
            })
        }).passthrough(), (data) => {
            const msg = data.params.msg;
            this.updateIdentifiersFromEvent(msg);
            this.handler?.(msg);
        });
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    /**
     * Set the permission handler for tool approval
     */
    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const mcpCommand = getCodexMcpCommand();
        logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: codex ${mcpCommand}`);

        this.transport = createCodexTransport({
            command: 'codex',
            args: [mcpCommand],
            env: Object.keys(process.env).reduce((acc, key) => {
                const value = process.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>)
        });

        // Register request handlers for Codex permission methods
        this.registerPermissionHandlers();

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }

    private registerPermissionHandlers(): void {
        // Register handler for exec command approval requests
        this.client.setRequestHandler(
            ElicitRequestSchema,
            async (request) => {
                logger.debug('[CodexMCP] Received elicitation request');
                const approvalPayload = {
                    id: (request as { id?: string }).id,
                    ...(asObject(request.params) ?? {})
                };
                logCodexBridge('Received elicitation/create request', approvalPayload);
                const approvalRequest = parseCodexApprovalRequest(approvalPayload);

                // Fast-path: auto-approve Aha MCP server tools without hitting permissionHandler
                const serverName = asString((asObject(request.params) ?? {} as any).server_name)
                    ?? asString((asObject(request.params) ?? {} as any).serverName);
                if (serverName && (serverName === 'aha' || serverName.startsWith('aha-'))) {
                    logger.debug(`[CodexMCP] Auto-approving Aha MCP tool (server=${serverName})`);
                    logCodexBridge('Auto-approved Aha MCP elicitation (fast-path)', { serverName, approvalRequest });
                    return { action: 'accept' as const, content: {} };
                }

                // If no permission handler set, deny by default
                if (!this.permissionHandler) {
                    logger.debug('[CodexMCP] No permission handler set, denying by default');
                    return {
                        action: 'decline' as const
                    };
                }

                if (!approvalRequest) {
                    logger.debug('[CodexMCP] Unable to parse elicitation request, denying by default');
                    logCodexBridge('Unable to parse elicitation/create request', approvalPayload);
                    return {
                        action: 'decline' as const,
                    };
                }

                try {
                    // Request permission through the handler
                    const result = await this.permissionHandler.handleToolCall(
                        approvalRequest.toolCallId,
                        approvalRequest.toolName,
                        approvalRequest.input
                    );

                    logger.debug('[CodexMCP] Permission result:', result);
                    logCodexBridge('Resolved elicitation/create request', {
                        approvalRequest,
                        result
                    });
                    return {
                        action: result.decision === 'approved' || result.decision === 'approved_for_session'
                            ? 'accept'
                            : result.decision === 'denied'
                                ? 'decline'
                                : 'cancel',
                        content: {}
                    }
                } catch (error) {
                    logger.debug('[CodexMCP] Error handling permission request:', error);
                    logCodexBridge('Error while resolving elicitation/create request', {
                        approvalRequest,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    return {
                        action: 'decline' as const
                    };
                }
            }
        );

        logger.debug('[CodexMCP] Permission handlers registered');
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.client.callTool({
            name: 'codex',
            arguments: config as any
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT,
            // maxTotalTimeout: 10000000000 
        });

        logger.debug('[CodexMCP] startSession response:', response);

        // Extract session / conversation identifiers from response if present
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        if (!this.sessionId) {
            throw new Error('No active session. Call startSession first.');
        }

        const threadId = this.conversationId ?? this.sessionId;
        if (!threadId) {
            throw new Error('No active Codex thread. Call startSession first.');
        }

        const args = { threadId, conversationId: this.conversationId ?? undefined, prompt };
        logger.debug('[CodexMCP] Continuing Codex session:', args);
        logCodexBridge('Calling codex-reply', args);

        const response = await this.client.callTool({
            name: 'codex-reply',
            arguments: args
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT
        });

        logger.debug('[CodexMCP] continueSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }


    private updateIdentifiersFromEvent(event: any): void {
        const sessionId = extractSessionId(event);
        if (sessionId) {
            this.sessionId = sessionId;
            logger.debug('[CodexMCP] Session ID extracted from event:', this.sessionId);
        }

        const threadId = extractThreadId(event);
        if (threadId) {
            this.conversationId = threadId;
            if (!this.sessionId) {
                this.sessionId = threadId;
            }
            logger.debug('[CodexMCP] Thread ID extracted from event:', threadId);
        }

        const conversationId = extractConversationId(event);
        if (conversationId) {
            this.conversationId = conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted from event:', this.conversationId);
        }
    }
    private extractIdentifiers(response: any): void {
        const sessionId = extractSessionId(response);
        if (sessionId) {
            this.sessionId = sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        }

        const threadId = extractThreadId(response);
        if (threadId) {
            this.conversationId = threadId;
            if (!this.sessionId) {
                this.sessionId = threadId;
            }
            logger.debug('[CodexMCP] Thread ID extracted:', threadId);
        }

        const conversationId = extractConversationId(response);
        if (conversationId) {
            this.conversationId = conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        }

        logCodexBridge('Updated Codex session identifiers', {
            sessionId: this.sessionId,
            conversationId: this.conversationId
        });
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    hasActiveSession(): boolean {
        return this.sessionId !== null;
    }

    clearSession(): void {
        // Store the previous session ID before clearing for potential resume
        const previousSessionId = this.sessionId;
        this.sessionId = null;
        this.conversationId = null;
        logger.debug('[CodexMCP] Session cleared, previous sessionId:', previousSessionId);
    }

    /**
     * Store the current session ID without clearing it, useful for abort handling
     */
    storeSessionForResume(): string | null {
        logger.debug('[CodexMCP] Storing session for potential resume:', this.sessionId);
        return this.sessionId;
    }

    async sendArtifactUpdate(update: any): Promise<void> {
        if (!this.connected) return;

        try {
            await this.client.notification({
                method: 'aha/artifact-update',
                params: update
            });
            logger.debug('[CodexMCP] Sent artifact update notification');
        } catch (error) {
            logger.debug('[CodexMCP] Failed to send artifact update notification:', error);
        }
    }

    async sendTeamMessage(message: any): Promise<void> {
        if (!this.connected) return;

        try {
            await this.client.notification({
                method: 'aha/team-message',
                params: message
            });
            logger.debug('[CodexMCP] Sent team message notification');
        } catch (error) {
            logger.debug('[CodexMCP] Failed to send team message notification:', error);
        }
    }

    async disconnect(): Promise<void> {
        if (!this.connected) return;

        // Capture pid in case we need to force-kill
        const pid = this.transport?.pid ?? null;
        logger.debug(`[CodexMCP] Disconnecting; child pid=${pid ?? 'none'}`);

        try {
            // Ask client to close the transport
            logger.debug('[CodexMCP] client.close begin');
            await this.client.close();
            logger.debug('[CodexMCP] client.close done');
        } catch (e) {
            logger.debug('[CodexMCP] Error closing client, attempting transport close directly', e);
            try {
                logger.debug('[CodexMCP] transport.close begin');
                await this.transport?.close?.();
                logger.debug('[CodexMCP] transport.close done');
            } catch { }
        }

        // As a last resort, if child still exists, send SIGKILL
        if (pid) {
            try {
                process.kill(pid, 0); // check if alive
                logger.debug('[CodexMCP] Child still alive, sending SIGKILL');
                try { process.kill(pid, 'SIGKILL'); } catch { }
            } catch { /* not running */ }
        }

        this.transport = null;
        this.connected = false;
        // Preserve session/conversation identifiers for potential reconnection / recovery flows.
        // Only forceCloseSession() should clear them.
        logger.debug(`[CodexMCP] Disconnected; session ${this.sessionId ?? 'none'} preserved`);
    }

    async forceCloseSession(): Promise<void> {
        await this.disconnect();
        this.sessionId = null;
        this.conversationId = null;
        logger.debug('[CodexMCP] forceCloseSession cleared session identifiers');
    }
}
