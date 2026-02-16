/**
 * Ralph MCP Server
 *
 * Provides structured MCP tools for the Ralph autonomous loop.
 * Each Claude iteration connects to this server to interact with
 * the PRD state via tool calls instead of raw file I/O.
 *
 * Follows the stateless HTTP pattern from startAhaServer.ts:
 * - McpServer from @modelcontextprotocol/sdk
 * - StreamableHTTPServerTransport in stateless mode
 * - HTTP server on port 0 (OS-assigned)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AddressInfo } from 'node:net';
import { logger } from '@/ui/logger';
import { loadPrd, getNextStory, markStoryComplete, appendProgress, getPrdStats } from './prdManager';
import type { RalphConfig, ProgressPhase } from './types';

interface RalphMcpServerResult {
    url: string;
    stop: () => void;
}

/**
 * Start the Ralph MCP server for a single loop session.
 *
 * @param config - Ralph loop configuration (prdPath, progressPath, etc.)
 * @param onProgress - Optional callback for progress reports
 */
export async function startRalphMcpServer(
    config: RalphConfig,
    onProgress?: (message: string, phase: ProgressPhase) => void
): Promise<RalphMcpServerResult> {

    // Factory: creates a fresh MCP server per request (stateless mode).
    // MCP SDK 1.26.0 requires a new transport per request.
    const createMcpInstance = () => {
        const mcp = new McpServer({
            name: 'Ralph MCP',
            version: '1.0.0',
            description: 'Ralph autonomous loop tools for PRD-driven development',
        });

        // ─── ralph_get_next_story ───────────────────────────────
        mcp.registerTool('ralph_get_next_story', {
            description: 'Get the next incomplete user story from the PRD, sorted by priority. Returns story details or "ALL_COMPLETE" if all stories are done.',
            title: 'Get Next Story',
            inputSchema: {},
        }, async () => {
            try {
                const prd = await loadPrd(config.prdPath);
                const story = getNextStory(prd);

                if (!story) {
                    return {
                        content: [{ type: 'text' as const, text: 'ALL_COMPLETE' }],
                        isError: false,
                    };
                }

                const { completed, total } = getPrdStats(prd);
                const storyInfo = {
                    ...story,
                    progress: `${completed}/${total} stories complete`,
                };

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(storyInfo, null, 2) }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{ type: 'text' as const, text: `Error loading PRD: ${String(error)}` }],
                    isError: true,
                };
            }
        });

        // ─── ralph_complete_story ───────────────────────────────
        mcp.registerTool('ralph_complete_story', {
            description: 'Mark a user story as complete. Updates prd.json (passes=true) and appends to progress.txt.',
            title: 'Complete Story',
            inputSchema: {
                storyId: z.string().describe('The story ID to mark complete (e.g. "US-001")'),
                notes: z.string().describe('Brief summary of what was implemented and any learnings'),
            },
        }, async (args) => {
            try {
                // Mark complete in prd.json
                await markStoryComplete(config.prdPath, args.storyId, args.notes);

                // Append to progress.txt
                const timestamp = new Date().toISOString();
                const entry = `## ${timestamp} - ${args.storyId}\n${args.notes}`;
                await appendProgress(config.progressPath, entry);

                // Get remaining count
                const prd = await loadPrd(config.prdPath);
                const { completed, total } = getPrdStats(prd);
                const remainingCount = total - completed;

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ success: true, remainingCount, completed, total }),
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{ type: 'text' as const, text: `Error completing story: ${String(error)}` }],
                    isError: true,
                };
            }
        });

        // ─── ralph_report_progress ──────────────────────────────
        mcp.registerTool('ralph_report_progress', {
            description: 'Report progress for real-time monitoring. Use at each phase: research, implementing, testing, committing.',
            title: 'Report Progress',
            inputSchema: {
                message: z.string().describe('Human-readable progress message'),
                phase: z.enum(['research', 'implementing', 'testing', 'committing']).describe('Current execution phase'),
            },
        }, async (args) => {
            try {
                logger.debug(`[Ralph MCP] Progress (${args.phase}): ${args.message}`);
                onProgress?.(args.message, args.phase as ProgressPhase);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{ type: 'text' as const, text: `Error reporting progress: ${String(error)}` }],
                    isError: true,
                };
            }
        });

        // ─── ralph_signal_complete ──────────────────────────────
        mcp.registerTool('ralph_signal_complete', {
            description: 'Signal that ALL user stories are complete. This will cause the Ralph loop to terminate after the current iteration.',
            title: 'Signal Complete',
            inputSchema: {},
        }, async () => {
            try {
                // Write sentinel file to signal loop termination
                const sentinelPath = join(config.workingDirectory, '.ralph-complete');
                writeFileSync(sentinelPath, `completed at ${new Date().toISOString()}\n`);
                logger.debug('[Ralph MCP] Complete sentinel written');

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Loop will terminate after this iteration' }) }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{ type: 'text' as const, text: `Error signaling complete: ${String(error)}` }],
                    isError: true,
                };
            }
        });

        return mcp;
    };

    // ─── HTTP Server (stateless mode) ───────────────────────────
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
            logger.debug('[Ralph MCP] Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[Ralph MCP] Server started at ${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        stop: () => {
            logger.debug('[Ralph MCP] Stopping server');
            server.close();
        },
    };
}
