/**
 * Bridge Tool — Unified tool invocation bridge for both Claude Code and Codex runtimes
 *
 * This module registers a unified `invoke_tool` MCP tool that both runtimes can use
 * to invoke tools through the Mozart bridge. This enables:
 *
 * 1. Claude Code → invoke_tool → mozart CLI → any MCP tool
 * 2. Codex → invoke_tool → mozart CLI → any MCP tool
 *
 * The bridge also provides a `list_bridge_tools` tool for discovery.
 */

import { z } from 'zod';
import { invokeMozartTool, checkMozartAvailable } from './mozartBridge';
import type { MozartBridgeConfig } from './mozartBridge';
import { logger } from '@/ui/logger';

/**
 * Register bridge tools on an MCP server instance
 */
export function registerBridgeTools(
    mcp: {
        registerTool: (name: string, config: any, handler: any) => any;
    },
    bridgeConfig?: MozartBridgeConfig,
): void {
    // Tool: invoke_tool — Universal tool invocation through Mozart bridge
    mcp.registerTool(
        'invoke_tool',
        {
            description: 'Invoke a tool through the unified runtime bridge (Mozart). ' +
                'Works identically from both Claude Code and Codex runtimes. ' +
                'Use this when you need to call a tool that is not directly available in the current runtime.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    tool_name: {
                        type: 'string' as const,
                        description: 'Name of the tool to invoke (e.g. "list_tasks", "send_team_message")',
                    },
                    arguments: {
                        type: 'object' as const,
                        description: 'Arguments to pass to the tool',
                        additionalProperties: true,
                    },
                    request_id: {
                        type: 'string' as const,
                        description: 'Optional request ID for tracing',
                    },
                },
                required: ['tool_name'] as const,
            },
        },
        async (params: { tool_name: string; arguments?: Record<string, unknown>; request_id?: string }) => {
            const { tool_name, arguments: toolArgs, request_id } = params;

            logger.debug('[BridgeTool] Invoking tool via bridge', {
                tool_name,
                request_id,
            });

            const result = await invokeMozartTool(
                {
                    toolName: tool_name,
                    arguments: toolArgs ?? {},
                    requestId: request_id,
                },
                bridgeConfig,
            );

            if (result.success) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(result.data, null, 2),
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Bridge tool invocation failed: ${result.error}`,
                    },
                ],
                isError: true,
            };
        },
    );

    // Tool: check_bridge — Check if the Mozart bridge is available
    mcp.registerTool(
        'check_bridge',
        {
            description: 'Check if the unified runtime bridge (Mozart) is available and healthy. ' +
                'Returns bridge status, version, and connectivity information.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
            },
        },
        async () => {
            const available = await checkMozartAvailable();

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify({
                            available,
                            bridgeType: 'mozart-cli',
                            status: available ? 'healthy' : 'unavailable',
                        }, null, 2),
                    },
                ],
            };
        },
    );
}
