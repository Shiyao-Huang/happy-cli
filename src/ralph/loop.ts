/**
 * Ralph Loop Orchestrator
 *
 * The main loop that drives the Ralph autonomous agent system.
 * Each iteration:
 *   1. Starts a Ralph MCP server
 *   2. Builds a system prompt with codebase patterns
 *   3. Spawns a fresh Claude process via sdk/query.ts
 *   4. Consumes the output stream
 *   5. Checks for completion sentinel
 *   6. Stops the MCP server
 *   7. Repeats or exits
 *
 * The loop is equivalent to ralph.sh's for-loop but integrated
 * into aha-cli with MCP tool support and progress push.
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import chalk from 'chalk';
import { logger } from '@/ui/logger';
import { query } from '@/claude/sdk/query';
import { loadPrd, getNextStory, getPrdStats, getCodebasePatterns } from './prdManager';
import { startRalphMcpServer } from './mcpServer';
import { buildSystemPrompt } from './systemPrompt';
import type { QueryOptions } from '@/claude/sdk/types';
import type { RalphConfig, RalphState, ProgressPhase } from './types';

/**
 * Run the Ralph autonomous loop.
 *
 * Iterates until all stories pass, max iterations reached,
 * or a stop signal is received.
 */
export async function runRalphLoop(config: RalphConfig): Promise<RalphState> {
    const {
        prdPath,
        progressPath,
        workingDirectory,
        maxIterations,
        permissionMode = 'bypassPermissions',
    } = config;

    const resolvedPrdPath = resolve(workingDirectory, prdPath);
    const resolvedProgressPath = resolve(workingDirectory, progressPath);
    const stopSentinel = join(workingDirectory, '.ralph-stop');
    const completeSentinel = join(workingDirectory, '.ralph-complete');

    // Clean up any stale sentinels from previous runs
    cleanupSentinel(stopSentinel);
    cleanupSentinel(completeSentinel);

    // Install SIGTERM handler for graceful stop (e.g. from daemon stop-session)
    const sigTermHandler = () => {
        logger.debug('[Ralph Loop] Received SIGTERM, writing stop sentinel');
        writeFileSync(stopSentinel, `stopped at ${new Date().toISOString()}\n`);
    };
    process.on('SIGTERM', sigTermHandler);

    const state: RalphState = {
        status: 'running',
        iteration: 0,
        maxIterations,
        currentStoryId: null,
        completed: 0,
        total: 0,
        startedAt: Date.now(),
    };

    try {
        // Validate PRD exists
        if (!existsSync(resolvedPrdPath)) {
            throw new Error(`PRD not found: ${resolvedPrdPath}`);
        }

        // Initial PRD stats
        const initialPrd = await loadPrd(resolvedPrdPath);
        const initialStats = getPrdStats(initialPrd);
        state.total = initialStats.total;
        state.completed = initialStats.completed;

        console.log(chalk.bold.cyan('\n  Ralph Loop'));
        console.log(chalk.gray(`  Project: ${initialPrd.project}`));
        console.log(chalk.gray(`  Branch:  ${initialPrd.branchName}`));
        console.log(chalk.gray(`  Stories: ${initialStats.completed}/${initialStats.total} complete`));
        console.log(chalk.gray(`  Max iterations: ${maxIterations}\n`));

        // ─── Main Loop ─────────────────────────────────────────
        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            state.iteration = iteration;

            // Check stop sentinel
            if (existsSync(stopSentinel)) {
                console.log(chalk.yellow('\n  Stopped by user request'));
                state.status = 'stopped';
                cleanupSentinel(stopSentinel);
                break;
            }

            // Check if there are incomplete stories
            const prd = await loadPrd(resolvedPrdPath);
            const nextStory = getNextStory(prd);
            const stats = getPrdStats(prd);
            state.completed = stats.completed;
            state.total = stats.total;

            if (!nextStory) {
                console.log(chalk.green('\n  All stories complete!'));
                state.status = 'complete';
                break;
            }

            state.currentStoryId = nextStory.id;

            console.log(chalk.bold(`\n  Iteration ${iteration}/${maxIterations}`));
            console.log(chalk.gray(`  Story: ${nextStory.id} - ${nextStory.title}`));
            console.log(chalk.gray(`  Progress: ${stats.completed}/${stats.total}`));

            // 1. Start Ralph MCP Server
            const onProgress = (message: string, phase: ProgressPhase) => {
                const phaseEmoji: Record<ProgressPhase, string> = {
                    research: '  [research]',
                    implementing: '  [implementing]',
                    testing: '  [testing]',
                    committing: '  [committing]',
                };
                console.log(chalk.gray(`${phaseEmoji[phase]} ${message}`));
            };

            const mcpServer = await startRalphMcpServer(
                { ...config, prdPath: resolvedPrdPath, progressPath: resolvedProgressPath },
                onProgress,
            );

            try {
                // 2. Build system prompt
                let codebasePatterns = '';
                try {
                    codebasePatterns = await getCodebasePatterns(resolvedProgressPath);
                } catch {
                    logger.debug('[Ralph Loop] Could not load codebase patterns, continuing without them');
                }
                const systemPrompt = buildSystemPrompt({
                    prd,
                    codebasePatterns,
                });

                // 3. Spawn Claude via sdk/query.ts in --print mode
                //    String prompt triggers --print flag = one-shot mode = fully isolated process
                const prompt = `You are starting iteration ${iteration} of the Ralph autonomous loop. Use the ralph_get_next_story tool to get your assignment, then implement it.`;

                logger.debug(`[Ralph Loop] Starting iteration ${iteration}, spawning Claude`);

                const queryOptions: QueryOptions = {
                    cwd: workingDirectory,
                    permissionMode: (permissionMode as QueryOptions['permissionMode']) || 'bypassPermissions',
                    model: config.model,
                    customSystemPrompt: systemPrompt,
                    mcpServers: {
                        ralph: { type: 'http', url: mcpServer.url },
                    },
                };

                const q = query({
                    prompt,
                    options: queryOptions,
                });

                // 4. Consume the SDK message stream until it completes
                for await (const message of q) {
                    // Log assistant text for visibility
                    if (message.type === 'assistant') {
                        const msg = message as { type: string; message?: { content?: Array<{ type: string; text?: string }> } };
                        if (msg.message?.content) {
                            for (const block of msg.message.content) {
                                if (block.type === 'text' && block.text) {
                                    logger.debug(`[Ralph Loop] Claude: ${block.text.substring(0, 200)}`);
                                }
                            }
                        }
                    }
                }

                logger.debug(`[Ralph Loop] Iteration ${iteration} Claude process completed`);

            } finally {
                // 5. Always stop MCP server
                mcpServer.stop();
            }

            // 6. Check completion sentinel
            if (existsSync(completeSentinel)) {
                console.log(chalk.green('\n  All stories complete! (signaled by agent)'));
                state.status = 'complete';
                cleanupSentinel(completeSentinel);
                break;
            }

            // 7. Brief pause between iterations
            await sleep(2000);
        }

        // Check for max iterations exhaustion
        if (state.status === 'running') {
            console.log(chalk.yellow(`\n  Max iterations (${maxIterations}) reached`));
            state.status = 'stopped';
        }

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`\n  Ralph Loop error: ${errorMsg}`));
        logger.debug('[Ralph Loop] Fatal error:', error);
        state.status = 'error';
    } finally {
        process.removeListener('SIGTERM', sigTermHandler);
        cleanupSentinel(stopSentinel);
        cleanupSentinel(completeSentinel);
        state.currentStoryId = null;

        // Final stats
        try {
            const finalPrd = await loadPrd(resolve(workingDirectory, prdPath));
            const finalStats = getPrdStats(finalPrd);
            state.completed = finalStats.completed;
            state.total = finalStats.total;
        } catch {
            // PRD may have been deleted or corrupted, keep last known stats
        }

        console.log(chalk.gray(`\n  Final: ${state.completed}/${state.total} stories complete`));
        console.log(chalk.gray(`  Status: ${state.status}\n`));
    }

    return state;
}

function cleanupSentinel(path: string): void {
    try {
        if (existsSync(path)) {
            unlinkSync(path);
        }
    } catch (error) {
        logger.debug(`[Ralph] Could not delete sentinel ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
