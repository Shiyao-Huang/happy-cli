/**
 * @module mozartHttpAdapter
 * @description HTTP adapter for the Mozart proxy server (PR-2).
 *
 * ```mermaid
 * graph LR
 *   A[mozartShim] --> B{MOZART_PROXY_URL set?}
 *   B -- yes --> C[HttpMozartAdapter]
 *   C --> D[Mozart HTTP Proxy]
 *   D --> E[Rust McpBridgeAdapter]
 *   B -- no --> F[StubMozartAdapter]
 * ```
 *
 * ## Design
 * - Reads `MOZART_PROXY_URL` env var to locate the Mozart HTTP proxy sidecar.
 * - Every request carries `MOZART_TIMEOUT_MS` (default 5000ms) via AbortSignal.
 *   This fixes FI-GAP-001: the Rust McpBridgeAdapter lacks reqwest timeout;
 *   the TypeScript layer enforces it so the shim's fallback kicks in reliably.
 * - When `MOZART_PROXY_URL` is not set, falls back to the stub adapter
 *   (zero behavior change — shim will still fallback to original handler).
 * - JSON-RPC 2.0 protocol matches the Rust McpBridgeAdapter wire format.
 */

import { logger } from '@/ui/logger';
import {
    type MozartAdapter,
    type MozartToolCall,
    type MozartAdapterResult,
    createStubMozartAdapter,
} from './mozartShim';

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;

export function getMozartProxyUrl(): string | undefined {
    return process.env.MOZART_PROXY_URL || undefined;
}

export function getMozartTimeoutMs(): number {
    const raw = process.env.MOZART_TIMEOUT_MS;
    if (!raw) return DEFAULT_TIMEOUT_MS;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

// ──────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 types (matches Rust McpBridgeAdapter wire format)
// ──────────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
    readonly jsonrpc: '2.0';
    readonly method: string;
    readonly params: unknown;
    readonly id: string;
}

interface JsonRpcResponse {
    readonly jsonrpc: '2.0';
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string };
    readonly id: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// HttpMozartAdapter
// ──────────────────────────────────────────────────────────────────────────────

export class HttpMozartAdapter implements MozartAdapter {
    readonly name = 'mozart-http-v0';

    constructor(
        private readonly proxyUrl: string,
        private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    ) {}

    async invoke(call: MozartToolCall): Promise<MozartAdapterResult> {
        const body: JsonRpcRequest = {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: call.toolName,
                arguments: call.args,
            },
            id: call.requestId,
        };

        const response = await this.post(body);

        if (response.error) {
            return {
                success: false,
                data: null,
                error: response.error.message,
            };
        }

        return {
            success: true,
            data: response.result ?? null,
        };
    }

    async listTools(): Promise<string[]> {
        const body: JsonRpcRequest = {
            jsonrpc: '2.0',
            method: 'tools/list',
            params: {},
            id: 'list-tools',
        };

        const response = await this.post(body);

        if (response.error || !response.result) {
            return [];
        }

        const result = response.result as { tools?: Array<{ name: string }> };
        return Array.isArray(result.tools)
            ? result.tools.map((t) => t.name).filter(Boolean)
            : [];
    }

    async healthCheck(): Promise<boolean> {
        try {
            const body: JsonRpcRequest = {
                jsonrpc: '2.0',
                method: 'health',
                params: {},
                id: 'health-check',
            };
            const response = await this.post(body);
            return !response.error;
        } catch {
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal: HTTP POST with timeout (fixes FI-GAP-001)
    // ─────────────────────────────────────────────────────────────────────────

    private async post(body: JsonRpcRequest): Promise<JsonRpcResponse> {
        // AbortSignal.timeout enforces the deadline — this is the TypeScript-side
        // fix for FI-GAP-001 (Rust McpBridgeAdapter lacks reqwest timeout).
        const signal = AbortSignal.timeout(this.timeoutMs);

        let response: Response;
        try {
            response = await fetch(this.proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal,
            });
        } catch (error) {
            const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
            const message = isTimeout
                ? `Mozart proxy timeout after ${this.timeoutMs}ms`
                : `Mozart proxy unreachable: ${error instanceof Error ? error.message : String(error)}`;
            logger.debug(`[mozartHttpAdapter] ${message}`);
            throw new Error(message);
        }

        if (!response.ok) {
            const message = `Mozart proxy HTTP ${response.status}`;
            logger.debug(`[mozartHttpAdapter] ${message}`);
            throw new Error(message);
        }

        try {
            return await response.json() as JsonRpcResponse;
        } catch (error) {
            const message = `Mozart proxy returned non-JSON: ${error instanceof Error ? error.message : String(error)}`;
            logger.debug(`[mozartHttpAdapter] ${message}`);
            throw new Error(message);
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory: createMozartAdapter()
// Returns HttpMozartAdapter when MOZART_PROXY_URL is set, else stub.
// Use this in index.ts instead of createStubMozartAdapter().
// ──────────────────────────────────────────────────────────────────────────────

export function createMozartAdapter(): MozartAdapter {
    const proxyUrl = getMozartProxyUrl();
    if (proxyUrl) {
        const timeoutMs = getMozartTimeoutMs();
        logger.debug(`[mozartHttpAdapter] Using HTTP adapter → ${proxyUrl} (timeout=${timeoutMs}ms)`);
        return new HttpMozartAdapter(proxyUrl, timeoutMs);
    }
    logger.debug('[mozartHttpAdapter] MOZART_PROXY_URL not set — using stub adapter');
    return createStubMozartAdapter();
}
