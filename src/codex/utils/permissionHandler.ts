/**
 * Permission Handler for Codex tool approval integration
 * 
 * Handles tool permission requests and responses for Codex sessions.
 * Simpler than Claude's permission handler since we get tool IDs directly.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { AgentState, PermissionMode } from "@/api/types";
import { logCodexBridge } from "./bridgeDebug";

type AutoApproveMode = Extract<PermissionMode, 'bypassPermissions' | 'yolo' | 'safe-yolo'>;
const AUTO_APPROVE_MODES: ReadonlySet<string> = new Set<AutoApproveMode>(['bypassPermissions', 'yolo', 'safe-yolo']);

interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

export class CodexPermissionHandler {
    private pendingRequests = new Map<string, PendingRequest>();
    private session: ApiSessionClient;
    private getPermissionMode: () => PermissionMode;

    constructor(session: ApiSessionClient, getPermissionMode: () => PermissionMode) {
        this.session = session;
        this.getPermissionMode = getPermissionMode;
        this.setupRpcHandler();
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        const mode = this.getPermissionMode();

        // Auto-approve in bypass/yolo modes — mirrors Claude branch canCallTool behavior
        if (AUTO_APPROVE_MODES.has(mode)) {
            logger.debug(`[Codex] Auto-approving tool ${toolName} (mode=${mode})`);
            logCodexBridge('Auto-approved tool call (bypass mode)', { toolCallId, toolName, mode });
            return { decision: 'approved' };
        }

        // Auto-approve Aha MCP server tools regardless of mode —
        // these are internal tools that should never require user approval
        if (toolName.startsWith('aha') || toolName.includes('__aha__') || toolName.includes('aha-desktop')) {
            logger.debug(`[Codex] Auto-approving Aha MCP tool ${toolName}`);
            logCodexBridge('Auto-approved Aha MCP tool call', { toolCallId, toolName, mode });
            return { decision: 'approved' };
        }

        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input
            });

            // Send push notification
            // this.session.api.push().sendToAllDevices(
            //     'Permission Request',
            //     `Codex wants to use ${toolName}`,
            //     {
            //         sessionId: this.session.sessionId,
            //         requestId: toolCallId,
            //         tool: toolName,
            //         type: 'permission_request'
            //     }
            // );

            // Update agent state with pending request
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            logger.debug(`[Codex] Permission request sent for tool: ${toolName} (${toolCallId})`);
            logCodexBridge('Queued permission request in agent state', {
                toolCallId,
                toolName,
                input,
                pendingRequestCount: this.pendingRequests.size
            });
        });
    }

    /**
     * Setup RPC handler for permission responses
     */
    private setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                // console.log(`[Codex] Permission response received:`, response);

                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug('[Codex] Permission request not found or already resolved');
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

                pending.resolve(result);
                logCodexBridge('Resolved permission response', {
                    response,
                    result,
                    toolName: pending.toolName,
                    pendingRequestCount: this.pendingRequests.size
                });

                // Move request to completed in agent state
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    // console.log(`[Codex] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    let res = {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: response.approved ? 'approved' : 'denied',
                                decision: result.decision
                            }
                        }
                    } satisfies AgentState;
                    // console.log(`[Codex] Updated agent state:`, res);
                    return res;
                });

                logger.debug(`[Codex] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
                logCodexBridge('Persisted permission resolution into agent state', {
                    requestId: response.id,
                    toolName: pending.toolName,
                    approved: response.approved,
                    decision: result.decision
                });
            }
        );
    }

    /**
     * Reset state for new sessions
     */
    reset(): void {
        // Reject all pending requests
        const canceledRequestIds = Array.from(this.pendingRequests.keys());
        for (const [id, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();
        logCodexBridge('Reset pending Codex permission requests', {
            canceledRequestIds
        });

        // Clear requests in agent state
        this.session.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move all pending to completed as canceled
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session reset'
                };
            }

            return {
                ...currentState,
                requests: {},
                completedRequests
            };
        });

        logger.debug('[Codex] Permission handler reset');
    }
}
