import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { daemonPost } from "@/daemon/controlClient";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

export type LifecycleDirectiveAction = 'retire' | 'standby';

export interface LifecycleDirective {
    action: LifecycleDirectiveAction;
    reason?: string;
    rawText: string;
}

const LEGACY_LIFECYCLE_SENTINELS = [
    'BOOTSTRAP_COMPLETE',
    'SUPERVISOR_COMPLETE',
    'HELP_COMPLETE',
    'ORG_MANAGER_COMPLETE',
] as const;

const FIRST_PARTY_ANTHROPIC_HOSTS = new Set([
    'api.anthropic.com',
    'api-staging.anthropic.com',
]);

function collectAssistantTextBlocks(content: unknown): string[] {
    if (typeof content === 'string') {
        return [content];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text as string);
}

export function extractLifecycleDirectiveFromContent(content: unknown): LifecycleDirective | null {
    const blocks = collectAssistantTextBlocks(content);
    let lastDirective: LifecycleDirective | null = null;

    for (const block of blocks) {
        const directiveRegex = /(?:^|\n)\s*<AHA_LIFECYCLE\s+action="(retire|standby)"(?:\s+reason="([^"\n<>]{1,120})")?\s*\/>\s*(?=$|\n)/gi;
        let match: RegExpExecArray | null = null;

        while ((match = directiveRegex.exec(block)) !== null) {
            lastDirective = {
                action: match[1].toLowerCase() as LifecycleDirectiveAction,
                reason: match[2]?.trim() || undefined,
                rawText: match[0].trim(),
            };
        }
    }

    return lastDirective;
}

function findLegacyLifecycleSentinels(content: unknown): string[] {
    const joined = collectAssistantTextBlocks(content).join('\n');
    if (!joined) {
        return [];
    }

    return LEGACY_LIFECYCLE_SENTINELS.filter((sentinel) => joined.includes(sentinel));
}

export function extractAnthropicBaseUrlHost(
    rawBaseUrl: string | undefined = process.env.ANTHROPIC_BASE_URL,
): string | null {
    if (!rawBaseUrl || rawBaseUrl.trim() === '') {
        return null;
    }

    try {
        return new URL(rawBaseUrl).host || null;
    } catch {
        return null;
    }
}

export function buildApiRetryDiagnosticMessage(
    message: Pick<SDKMessage & {
        subtype?: string;
        attempt?: number;
        max_retries?: number;
        error_status?: number;
        error?: string;
    }, 'type' | 'subtype' | 'attempt' | 'max_retries' | 'error_status' | 'error'>,
    rawBaseUrl: string | undefined = process.env.ANTHROPIC_BASE_URL,
): string | null {
    if (message.type !== 'system' || message.subtype !== 'api_retry') {
        return null;
    }

    if (message.error_status !== 502 || message.error !== 'server_error') {
        return null;
    }

    if (
        typeof message.attempt !== 'number'
        || typeof message.max_retries !== 'number'
        || message.attempt < message.max_retries
    ) {
        return null;
    }

    const host = extractAnthropicBaseUrlHost(rawBaseUrl);
    if (host && !FIRST_PARTY_ANTHROPIC_HOSTS.has(host)) {
        return `Claude API 连续 ${message.max_retries} 次重试后仍收到 502。当前走的是自定义 relay ${host}，不是 Anthropic 官方直连；请先检查 relay 的上游、配额和模型映射。`;
    }

    if (host) {
        return `Claude API 连续 ${message.max_retries} 次重试后仍收到 502。当前命中上游 ${host}；这是上游 server_error，不是 Aha 本地队列或 daemon 自身故障。`;
    }

    return `Claude API 连续 ${message.max_retries} 次重试后仍收到 502。当前未检测到自定义 ANTHROPIC_BASE_URL；这更像上游服务抖动，不是 Aha 本地队列或 daemon 自身故障。`;
}

function parseStandbyAutoExitMs(envName: string, fallbackMs: number): number | null {
    const raw = process.env[envName];
    if (raw == null || raw.trim() === '') {
        return fallbackMs;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}

/**
 * Genome-first standby auto-exit resolution.
 * Priority: env var override → genome behavior.standbyAutoExitMs → null (no auto-exit).
 * No role string checks — the value comes from the genome or env.
 */
export function resolveStandbyAutoExitMs(
    _role?: string,
    genome?: { behavior?: { standbyAutoExitMs?: number } } | null,
): number | null {
    // Env override (backwards compat for ops)
    const envRaw = process.env.AHA_STANDBY_AUTO_EXIT_MS;
    if (envRaw != null && envRaw.trim() !== '') {
        const parsed = Number.parseInt(envRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        if (envRaw.trim() === '0' || envRaw.trim() === 'null') return null;
    }

    // Genome-first
    if (typeof genome?.behavior?.standbyAutoExitMs === 'number' && genome.behavior.standbyAutoExitMs > 0) {
        return genome.behavior.standbyAutoExitMs;
    }

    return null;
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
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

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;
    let retireTimer: NodeJS.Timeout | null = null;
    let standbyTimer: NodeJS.Timeout | null = null;

    const clearStandbyTimer = (reason?: string) => {
        if (!standbyTimer) {
            return;
        }

        clearTimeout(standbyTimer);
        standbyTimer = null;
        logger.debug(
            `[remote]: Cleared standby auto-exit timer${reason ? ` (${reason})` : ''}`
        );
    };

    const resolveLifecycleRole = (): string | undefined =>
        process.env.AHA_AGENT_ROLE
        || session.client.getMetadata()?.role
        || undefined;

    async function abort() {
        clearStandbyTimer('abort');
        if (retireTimer) {
            clearTimeout(retireTimer);
            retireTimer = null;
        }
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());


    // Handle messages
    let planModeToolCalls = new Set<string>();
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    const reportedApiRetryDiagnostics = new Set<string>();

    function onMessage(message: SDKMessage) {

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Write to permission handler for tool id resolving
        permissionHandler.onMessage(message);

        if (message.type === 'user') {
            clearStandbyTimer('new inbound message');
        }

        const apiRetryDiagnostic = buildApiRetryDiagnosticMessage(message);
        if (apiRetryDiagnostic) {
            const diagnosticKey = (message as any).uuid || `${(message as any).session_id || 'unknown'}:${(message as any).attempt}/${(message as any).max_retries}`;
            if (!reportedApiRetryDiagnostics.has(diagnosticKey)) {
                reportedApiRetryDiagnostics.add(diagnosticKey);
                logger.debug(`[remote]: ${apiRetryDiagnostic}`);
                messageBuffer.addMessage(apiRetryDiagnostic, 'status');
                session.client.sendSessionEvent({ type: 'message', message: apiRetryDiagnostic });
            }
        }

        // Lifecycle is agent-controlled via explicit directives, never via loose substring matching.
        if (message.type === 'assistant') {
            const umessage = message as SDKAssistantMessage;
            const content = (umessage.message as any)?.content;
            const directive = extractLifecycleDirectiveFromContent(content);
            if (directive) {
                logger.debug(
                    `[remote]: lifecycle directive received: action=${directive.action}` +
                    `${directive.reason ? ` reason=${directive.reason}` : ''}`
                );

                if (directive.action === 'retire' && !retireTimer) {
                    clearStandbyTimer('explicit retire directive');
                    retireTimer = setTimeout(() => {
                        void (async () => {
                            const nowIso = new Date().toISOString();
                            try {
                                await session.client.updateMetadata((currentMetadata) => ({
                                    ...currentMetadata,
                                    lifecycleState: 'retired',
                                    lifecycleStateSince: Date.now(),
                                    closedAt: currentMetadata?.closedAt || nowIso,
                                    retiredAt: currentMetadata?.retiredAt || nowIso,
                                    retiredBy: 'runtime',
                                    retireReason: directive.reason || 'explicit-retire-directive',
                                }));
                                await session.client.flush();
                            } catch (error) {
                                logger.debug('[remote]: Failed to persist retired metadata before exit:', error);
                            }

                            logger.debug(
                                `[remote]: Retiring agent via explicit lifecycle directive` +
                                `${directive.reason ? ` (${directive.reason})` : ''}`
                            );
                            if (!exitReason) {
                                exitReason = 'exit';
                            }
                            abort().catch(() => {});
                        })();
                    }, 2000);
                }

                if (directive.action === 'standby') {
                    const role = resolveLifecycleRole();
                    const standbyAutoExitMs = resolveStandbyAutoExitMs(role);
                    if (standbyAutoExitMs != null) {
                        clearStandbyTimer('refresh standby window');
                        standbyTimer = setTimeout(() => {
                            void (async () => {
                                const nowIso = new Date().toISOString();
                                try {
                                    await session.client.updateMetadata((currentMetadata) => ({
                                        ...currentMetadata,
                                        lifecycleState: 'auto-retired',
                                        lifecycleStateSince: Date.now(),
                                        closedAt: currentMetadata?.closedAt || nowIso,
                                        retiredAt: currentMetadata?.retiredAt || nowIso,
                                        retiredBy: 'runtime',
                                        retireReason: directive.reason || 'standby-auto-exit',
                                    }));
                                    await session.client.flush();
                                } catch (error) {
                                    logger.debug('[remote]: Failed to persist auto-retired metadata before exit:', error);
                                }

                                logger.debug(
                                    `[remote]: Auto-retiring standby agent after ${standbyAutoExitMs}ms` +
                                    `${role ? ` (role=${role})` : ''}` +
                                    `${directive.reason ? ` (${directive.reason})` : ''}`
                                );
                                if (!exitReason) {
                                    exitReason = 'exit';
                                }
                                abort().catch(() => {});
                            })();
                        }, standbyAutoExitMs);
                        logger.debug(
                            `[remote]: Agent explicitly chose standby; auto-exit scheduled in ${standbyAutoExitMs}ms` +
                            `${role ? ` for role=${role}` : ''}` +
                            `${directive.reason ? ` (${directive.reason})` : ''}`
                        );
                    } else {
                        logger.debug(
                            `[remote]: Agent explicitly chose standby; session will remain alive` +
                            `${directive.reason ? ` (${directive.reason})` : ''}`
                        );
                    }
                }
            }

            const legacySentinels = findLegacyLifecycleSentinels(content);
            if (legacySentinels.length > 0) {
                logger.debug(
                    `[remote]: Ignoring legacy lifecycle sentinel(s): ${legacySentinels.join(', ')}. ` +
                    `Only explicit <AHA_LIFECYCLE ... /> directives can retire a session.`
                );
            }
        }

        // Detect plan mode tool call
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                        logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                        planModeToolCalls.add(c.id! as string);
                    }
                }
            }
        }

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        // Hack plan mode exit
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                msg = {
                    ...umessage,
                    message: {
                        ...umessage.message,
                        content: umessage.message.content.map((c) => {
                            if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                if (c.content === PLAN_FAKE_REJECT) {
                                    logger.debug('[remote]: hack plan mode exit');
                                    logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                    return {
                                        ...c,
                                        is_error: false,
                                        content: 'Plan approved',
                                        mode: c.mode
                                    }
                                } else {
                                    return c;
                                }
                            }
                            return c;
                        })
                    }
                }
            }
        }

        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        let pending: {
            message: string;
            mode: EnhancedMode;
        } | null = null;

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/aha-cli/issues/143
        const MAX_RETRIES = 5;
        const BASE_BACKOFF_MS = 1000;
        let retryCount = 0;

        let previousSessionId: string | null = null;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            try {
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        if (pending) {
                            let p = pending;
                            pending = null;
                            permissionHandler.handleModeChange(p.mode.permissionMode);
                            return p;
                        }

                        let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                        // Check if mode has changed
                        if (msg) {
                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                return null;
                            }
                            modeHash = msg.hash;
                            mode = msg.mode;
                            permissionHandler.handleModeChange(mode.permissionMode);
                            return {
                                message: msg.message,
                                mode: msg.mode
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                        // Notify daemon so it can map ahaSessionId → claudeLocalSessionId
                        // (used by supervisor to locate CC JSONL logs by teamId)
                        const ahaSessionId = session.client.sessionId;
                        if (ahaSessionId) {
                            daemonPost('/session-found', { ahaSessionId, claudeLocalSessionId: sessionId })
                                .catch((e: unknown) => logger.debug(`[remote]: Failed to report local session to daemon: ${e}`));
                        }
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    settingsPath: session.settingsPath,
                    maxTurns: session.maxTurns,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                    },
                    onReady: () => {
                        if (!pending && session.queue.size() === 0) {
                            session.client.sendSessionEvent({ type: 'ready' });
                            session.api.push().sendToAllDevices(
                                'It\'s ready!',
                                `Claude is waiting for your command`,
                                { sessionId: session.client.sessionId }
                            );
                        }
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();

                // Normal completion — reset retry count
                retryCount = 0;

                if (!exitReason && abortController.signal.aborted) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                const errorDetail = e instanceof Error
                    ? { message: e.message, name: e.name, stack: e.stack?.split('\n').slice(0, 3).join('\n') }
                    : JSON.stringify(e);
                logger.debug('[remote]: launch error', errorDetail);

                retryCount++;
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });

                    if (retryCount >= MAX_RETRIES) {
                        logger.debug(`[remote]: Max retries (${MAX_RETRIES}) reached after launch errors. Giving up.`);
                        session.client.sendSessionEvent({ type: 'message', message: `Process failed after ${MAX_RETRIES} retries` });
                        exitReason = 'exit';
                        break;
                    }

                    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount - 1);
                    logger.debug(`[remote]: Waiting ${backoffMs}ms before retry ${retryCount}/${MAX_RETRIES}`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                }
            } finally {

                logger.debug('[remote]: launch finally');

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                modeHash = null;
                mode = null;
            }
        }
    } finally {

        // Clean up permission handler
        permissionHandler.reset();

        // Reset Terminal
        process.stdin.off('data', abort);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
