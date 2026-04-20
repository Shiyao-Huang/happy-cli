/**
 * Mozart Bridge — Bash CLI wrapper for unified tool invocation
 *
 * This module provides a bridge layer that uses the `mozart invoke` CLI command,
 * which works universally across both Claude Code (via Bash tool) and Codex (via exec_command).
 *
 * CLI usage:
 *   mozart invoke --tool <name> --payload <json> [--mcp-url <url>] [--remote-url <url>]
 */

import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';
import type { ToolInvocation, ToolResult } from './types';

/**
 * Mozart bridge configuration
 */
export interface MozartBridgeConfig {
    /**
     * Path to mozart CLI binary (defaults to 'mozart' from PATH)
     */
    mozartPath?: string;

    /**
     * Default MCP server URL
     */
    mcpUrl?: string;

    /**
     * Default remote HTTP endpoint
     */
    remoteUrl?: string;

    /**
     * Request timeout in milliseconds
     */
    timeout?: number;
}

/**
 * Default timeout for mozart invoke commands (30 seconds)
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Trace ID generator for structured logging
 */
function generateTraceId(): string {
    return `mozart_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Invoke a tool through the Mozart bridge
 *
 * @param invocation - Tool invocation details
 * @param config - Bridge configuration
 * @returns Tool execution result
 */
export async function invokeMozartTool(
    invocation: ToolInvocation,
    config: MozartBridgeConfig = {}
): Promise<ToolResult> {
    const traceId = generateTraceId();
    const startTime = Date.now();
    const mozartPath = config.mozartPath || 'mozart';
    const timeout = config.timeout ?? DEFAULT_TIMEOUT;

    logger.debug('[MozartBridge] Invoking tool', {
        traceId,
        tool: invocation.toolName,
        args: invocation.arguments,
    });

    try {
        // Build CLI arguments
        const args = ['invoke', '--tool', invocation.toolName, '--payload', JSON.stringify(invocation.arguments)];

        if (config.mcpUrl) {
            args.push('--mcp-url', config.mcpUrl);
        }
        if (config.remoteUrl) {
            args.push('--remote-url', config.remoteUrl);
        }

        // Create abort controller for timeout
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), timeout);

        // Spawn mozart process
        const result = await spawnMozart(mozartPath, args, {
            signal: abortController.signal,
            traceId,
        });

        clearTimeout(timeoutId);

        const latencyMs = Date.now() - startTime;

        // Parse output
        const output = result.stdout.trim();
        let data: unknown;
        try {
            data = output ? JSON.parse(output) : null;
        } catch {
            // Non-JSON output — treat as string data
            data = { output };
        }

        // Check exit code
        if (result.exitCode !== 0) {
            const errorMsg = result.stderr || `Mozart exited with code ${result.exitCode}`;
            logger.debug('[MozartBridge] Tool invocation failed', {
                traceId,
                exitCode: result.exitCode,
                error: errorMsg,
                latencyMs,
            });

            return {
                success: false,
                error: errorMsg,
                metadata: {
                    latencyMs,
                    adapter: 'mozart-cli',
                    fallbackReason: 'non-zero-exit-code',
                },
            };
        }

        logger.debug('[MozartBridge] Tool invocation succeeded', {
            traceId,
            latencyMs,
        });

        return {
            success: true,
            data,
            metadata: {
                latencyMs,
                adapter: 'mozart-cli',
            },
        };
    } catch (error) {
        const latencyMs = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.debug('[MozartBridge] Tool invocation error', {
            traceId,
            error: errorMessage,
            latencyMs,
        });

        return {
            success: false,
            error: errorMessage,
            metadata: {
                latencyMs,
                adapter: 'mozart-cli',
                fallbackReason: 'spawn-error',
            },
        };
    }
}

/**
 * Spawn result
 */
interface SpawnResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

/**
 * Spawn mozart CLI and capture output
 */
async function spawnMozart(
    command: string,
    args: string[],
    options: {
        signal?: AbortSignal;
        traceId: string;
    }
): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const stdout: string[] = [];
        const stderr: string[] = [];

        logger.debug('[MozartBridge] Spawning process', {
            traceId: options.traceId,
            command: `${command} ${args.join(' ')}`,
        });

        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: options.signal,
        });

        child.stdout?.on('data', (data: Buffer) => {
            stdout.push(data.toString());
        });

        child.stderr?.on('data', (data: Buffer) => {
            stderr.push(data.toString());
        });

        child.on('error', (error: Error) => {
            logger.debug('[MozartBridge] Process error', {
                traceId: options.traceId,
                error: error.message,
            });
            reject(error);
        });

        child.on('close', (code: number | null) => {
            resolve({
                stdout: stdout.join(''),
                stderr: stderr.join(''),
                exitCode: code,
            });
        });
    });
}

/**
 * Check if Mozart CLI is available
 */
export async function checkMozartAvailable(): Promise<boolean> {
    try {
        const result = await spawnMozart('mozart', ['--version'], { traceId: 'version_check' });
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

/**
 * Get Mozart version information
 */
export async function getMozartVersion(): Promise<string | null> {
    try {
        const result = await spawnMozart('mozart', ['--version'], { traceId: 'version_check' });
        if (result.exitCode === 0) {
            return result.stdout.trim();
        }
        return null;
    } catch {
        return null;
    }
}
