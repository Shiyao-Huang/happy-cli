/**
 * @module mozartShim
 * @description Feature-flagged MCP adapter shim for Mozart Phase-1.
 *
 * ```mermaid
 * graph LR
 *   A[tool call] --> B{MOZART_ENABLED?}
 *   B -- no --> C[original handler]
 *   B -- yes --> D[MozartAdapter.invoke]
 *   D -- success --> E[return mozart result]
 *   D -- failure --> F[fallback to original handler]
 *   F --> G[return original result]
 * ```
 *
 * ## Design
 * - MOZART_ENABLED=1 activates new path; all other values (default '0') = passthrough.
 * - Fallback triggers on any Mozart error (timeout / schema / panic).
 * - Every call emits structured log: { trace_id, adapter, latency_ms, result, fallback_reason }.
 * - Phase-1 Mozart path returns a stub result (no live Rust bridge yet).
 * - File stays <500 lines per project constraints.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type MozartResult = 'mozart' | 'fallback' | 'passthrough';

export interface ShimLog {
    readonly trace_id: string;
    readonly adapter: string;
    readonly latency_ms: number;
    readonly result: MozartResult;
    readonly fallback_reason?: string;
}

export interface MozartToolCall {
    readonly toolName: string;
    readonly args: unknown;
    readonly requestId: string;
}

export interface MozartAdapterResult {
    readonly success: boolean;
    readonly data: unknown;
    readonly error?: string;
}

export interface MozartAdapter {
    readonly name: string;
    invoke(call: MozartToolCall): Promise<MozartAdapterResult>;
    listTools(): Promise<string[]>;
    healthCheck(): Promise<boolean>;
}

// Handler type mirrors the MCP SDK tool handler signature
export type ToolHandler<TArgs = unknown, TResult = unknown> = (args: TArgs) => Promise<TResult>;

// ──────────────────────────────────────────────────────────────────────────────
// Feature flag
// ──────────────────────────────────────────────────────────────────────────────

export function isMozartEnabled(): boolean {
    return process.env.MOZART_ENABLED === '1';
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase-1 stub adapter
// Returned by createStubMozartAdapter() for in-process use.
// When the real Rust bridge is ready, replace this with a live adapter.
// ──────────────────────────────────────────────────────────────────────────────

export function createStubMozartAdapter(): MozartAdapter {
    return {
        name: 'mozart-stub-v0',

        async invoke(call: MozartToolCall): Promise<MozartAdapterResult> {
            // Phase-1 stub: echo the tool name and args back as data.
            // This proves the routing works without requiring the Rust bridge.
            return {
                success: true,
                data: {
                    __stub__: true,
                    toolName: call.toolName,
                    requestId: call.requestId,
                    receivedArgs: call.args,
                },
            };
        },

        async listTools(): Promise<string[]> {
            return [];
        },

        async healthCheck(): Promise<boolean> {
            return true;
        },
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Shim log
// ──────────────────────────────────────────────────────────────────────────────

function emitShimLog(log: ShimLog): void {
    logger.debug(`[mozartShim] ${JSON.stringify(log)}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Core: wrapWithMozart
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Wraps a registered MCP tool handler with the Mozart shim.
 *
 * Behavior:
 * - MOZART_ENABLED != '1' → passthrough (original handler, zero overhead).
 * - MOZART_ENABLED = '1'  → invoke Mozart adapter; fallback to original on error.
 *
 * @param toolName   MCP tool name (for logging / routing).
 * @param handler    Original MCP tool handler.
 * @param adapter    Mozart adapter instance (injectable for tests).
 */
export function wrapWithMozart<TArgs, TResult>(
    toolName: string,
    handler: ToolHandler<TArgs, TResult>,
    adapter: MozartAdapter = createStubMozartAdapter(),
): ToolHandler<TArgs, TResult> {
    return async (args: TArgs): Promise<TResult> => {
        if (!isMozartEnabled()) {
            // Passthrough: flag is off — zero behavior change.
            const start = Date.now();
            const result = await handler(args);
            emitShimLog({
                trace_id: randomUUID(),
                adapter: 'none',
                latency_ms: Date.now() - start,
                result: 'passthrough',
            });
            return result;
        }

        const traceId = randomUUID();
        const requestId = randomUUID();
        const shimStart = Date.now();

        // Mozart path
        try {
            const mozartStart = Date.now();
            const adapterResult = await adapter.invoke({
                toolName,
                args,
                requestId,
            });
            const latency = Date.now() - mozartStart;

            if (!adapterResult.success) {
                throw new Error(adapterResult.error ?? 'Mozart adapter returned success=false');
            }

            emitShimLog({
                trace_id: traceId,
                adapter: adapter.name,
                latency_ms: latency,
                result: 'mozart',
            });

            // In Phase-1 the stub result is diagnostic only.
            // We still run the original handler so the MCP caller gets the real response.
            // Remove this passthrough once the Rust bridge produces real output.
            return await handler(args);

        } catch (mozartError) {
            const fallbackReason = mozartError instanceof Error
                ? mozartError.message
                : String(mozartError);

            logger.debug(`[mozartShim] Mozart path failed (trace=${traceId}): ${fallbackReason}`);

            // Fallback: run original handler
            try {
                const fallbackStart = Date.now();
                const fallbackResult = await handler(args);
                emitShimLog({
                    trace_id: traceId,
                    adapter: adapter.name,
                    latency_ms: Date.now() - shimStart,
                    result: 'fallback',
                    fallback_reason: fallbackReason,
                });
                return fallbackResult;
            } catch (fallbackError) {
                // Both paths failed — propagate original handler error
                emitShimLog({
                    trace_id: traceId,
                    adapter: adapter.name,
                    latency_ms: Date.now() - shimStart,
                    result: 'fallback',
                    fallback_reason: `mozart=${fallbackReason}; fallback=${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
                });
                throw fallbackError;
            }
        }
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Convenience: wrap the mcp.registerTool call instead of the handler
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns a patched version of an MCP server's registerTool method
 * that automatically wraps every handler with the Mozart shim.
 *
 * Usage in index.ts:
 *   mcp.registerTool = patchRegisterTool(mcp.registerTool.bind(mcp), adapter);
 */
export function patchRegisterTool(
    originalRegisterTool: (name: string, config: unknown, handler: ToolHandler) => unknown,
    adapter: MozartAdapter = createStubMozartAdapter(),
): (name: string, config: unknown, handler: ToolHandler) => unknown {
    return (name: string, config: unknown, handler: ToolHandler) => {
        const wrappedHandler = wrapWithMozart(name, handler, adapter);
        return originalRegisterTool(name, config, wrappedHandler);
    };
}
