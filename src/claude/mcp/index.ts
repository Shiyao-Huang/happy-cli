/**
 * @module index
 * @description Thin shell that builds McpToolContext and wires up all MCP tool modules.
 * This module replaces the original startAhaServer.ts god-file by delegating each
 * group of tools to its own register* function.
 *
 * ```mermaid
 * graph LR
 *   A[startAhaServer] --> B[buildMcpHelpers]
 *   A --> C[registerContextTools]
 *   A --> D[registerTeamTools]
 *   A --> E[registerTaskTools]
 *   A --> F[registerAgentTools]
 *   A --> G[registerSupervisorTools]
 *   A --> H[registerEvolutionTools]
 *   A --> I[HTTP server]
 * ```
 *
 * ## Design
 * - One McpServer instance is created per HTTP request (stateless mode).
 * - buildMcpHelpers() creates all shared closures once per request.
 * - Each register* function receives the full McpToolContext.
 * - The HTTP server, resources, and return shape are unchanged from the original.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { readDaemonState } from '@/persistence';
import { buildMcpHelpers, McpToolContext } from './mcpContext';
import { registerContextTools } from './contextTools';
import { registerTeamTools } from './teamTools';
import { registerTaskTools } from './taskTools';
import { registerAgentTools } from './agentTools';
import { registerSupervisorTools } from './supervisorTools';
import { registerEvolutionTools } from './evolutionTools';

export async function startAhaServer(
    api: any,
    client: ApiSessionClient,
    genomeSpecRef?: { current: import('../../api/types/genome').GenomeSpec | null | undefined },
) {
    // Debounced heartbeat ping to daemon — fires at most once per 10s on MCP tool calls
    let lastHeartbeatPing = 0;
    const pingDaemonHeartbeat = async (): Promise<void> => {
        const now = Date.now();
        if (now - lastHeartbeatPing < 10_000) return; // debounce 10s
        lastHeartbeatPing = now;
        try {
            const meta = client.getMetadata();
            const teamId = meta?.teamId || meta?.roomId;
            if (!teamId || !meta?.ahaSessionId) return;
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) return;
            fetch(`http://127.0.0.1:${daemonState.httpPort}/heartbeat-ping`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: meta.ahaSessionId, teamId, role: meta.role || 'unknown' }),
                signal: AbortSignal.timeout(2_000),
            }).catch(() => {}); // fire-and-forget
        } catch { /* never block MCP flow */ }
    };

    // Handler that sends title updates via the client
    const handler = async (title: string): Promise<{ success: boolean; error?: string }> => {
        logger.debug('[ahaMCP] Changing title to:', title);
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID(),
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    //
    // Factory function: creates a fresh MCP server per request.
    // MCP SDK 1.26.0 requires a new transport per request in stateless mode
    // ("Stateless transport cannot be reused across requests").
    //
    const createMcpInstance = () => {
        const mcp = new McpServer({
            name: "Aha MCP",
            version: "1.0.0",
            description: "Aha CLI MCP server with chat session management tools",
        });

        // Build shared helpers from the outer closure variables
        const helpers = buildMcpHelpers(api, client, genomeSpecRef);

        const ctx: McpToolContext = {
            mcp,
            api,
            client,
            genomeSpecRef,
            handler,
            pingDaemonHeartbeat,
            ...helpers,
        };

        //
        // Context Resources (Rules & Preferences)
        //
        mcp.registerResource(
            "aha://context/rules",
            "Global Rules",
            {
                description: "Global rules for the agent",
                mimeType: "text/plain",
            },
            async (uri: { href: string }) => {
                try {
                    const result = await api.kvGet('config.rules');
                    const rules = result
                        ? result.value
                        : "1. Be concise and efficient.\n2. Verify code before execution.\n3. Prioritize user security.";
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: "text/plain",
                            text: rules,
                        }],
                    };
                } catch (e) {
                    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Error loading rules." }] };
                }
            },
        );

        mcp.registerResource(
            "aha://context/preferences",
            "User Preferences",
            {
                description: "User preferences for the agent",
                mimeType: "text/plain",
            },
            async (uri: { href: string }) => {
                try {
                    const result = await api.kvGet('config.preferences');
                    const prefs = result
                        ? result.value
                        : "Language: English\nRole: Assistant\nStyle: Professional";
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: "text/plain",
                            text: prefs,
                        }],
                    };
                } catch (e) {
                    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Error loading preferences." }] };
                }
            },
        );

        // Register all tool groups
        registerContextTools(ctx);
        registerTeamTools(ctx);
        registerTaskTools(ctx);
        registerAgentTools(ctx);
        registerSupervisorTools(ctx);
        registerEvolutionTools(ctx);

        return mcp;
    };

    //
    // Create the HTTP server
    // MCP SDK 1.26.0 stateless mode requires a new transport + server per request.
    // See: simpleStatelessStreamableHttp.js in @modelcontextprotocol/sdk examples.
    //
    const server = createServer(async (req, res) => {
        try {
            const mcp = createMcpInstance();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolNames: [
            'change_title',
            'send_team_message',
            'get_context_status',
            'get_team_info',
            'create_task',
            'update_task',
            'add_task_comment',
            'delete_task',
            'list_tasks',
            // 嵌套任务工具 (v2)
            'create_subtask',
            'list_subtasks',
            'start_task',
            'complete_task',
            'report_blocker',
            'resolve_blocker',
            // Agent spawning tools
            'list_available_agents',
            'create_agent',
            'list_team_agents',
            'request_help',
            'replace_agent',
            'evaluate_replacement_votes',
            'update_agent_model',
            // Evolution system (M3)
            'create_genome',
            // Supervisor-only tools
            'read_team_log',
            'read_cc_log',
            'list_team_cc_logs',
            'list_team_runtime_logs',
            'read_runtime_log',
            'score_agent',
            'score_supervisor_self',
            'update_genome_feedback',
            'evolve_genome',
            'update_team_feedback',
            'compact_agent',
            'kill_agent',
            'save_supervisor_state',
        ],
        stop: () => {
            logger.debug('[ahaMCP] Stopping server');
            server.close();
        },
    };
}
