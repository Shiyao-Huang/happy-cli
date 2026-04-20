/**
 * @module mozartHttpAdapter.test
 * @description TDD tests for HttpMozartAdapter and createMozartAdapter factory.
 *
 * Coverage:
 * - P0: invoke() success → returns data
 * - P0: invoke() server returns error → success=false + error message
 * - P0: invoke() network timeout → throws (triggers shim fallback)
 * - P0: invoke() HTTP 500 → throws (triggers shim fallback)
 * - P0: listTools() success → returns tool name array
 * - P0: listTools() server error → returns empty array (safe degradation)
 * - P0: healthCheck() success → true
 * - P0: healthCheck() failure → false (no throw)
 * - createMozartAdapter() → stub when MOZART_PROXY_URL unset
 * - createMozartAdapter() → HttpMozartAdapter when MOZART_PROXY_URL set
 * - getMozartTimeoutMs() defaults and custom values
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    HttpMozartAdapter,
    createMozartAdapter,
    getMozartProxyUrl,
    getMozartTimeoutMs,
} from './mozartHttpAdapter';

// ──────────────────────────────────────────────────────────────────────────────
// Fetch mock helpers
// ──────────────────────────────────────────────────────────────────────────────

function mockFetchOk(body: unknown): void {
    global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
    } as unknown as Response);
}

function mockFetchHttpError(status: number): void {
    global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: () => Promise.resolve({}),
    } as unknown as Response);
}

function mockFetchNetworkError(message = 'Network failure'): void {
    global.fetch = vi.fn().mockRejectedValue(new Error(message));
}

function mockFetchTimeout(): void {
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');
    global.fetch = vi.fn().mockRejectedValue(timeoutError);
}

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// ──────────────────────────────────────────────────────────────────────────────
// getMozartTimeoutMs
// ──────────────────────────────────────────────────────────────────────────────

describe('getMozartTimeoutMs', () => {
    afterEach(() => { delete process.env.MOZART_TIMEOUT_MS; });

    it('returns 5000 by default', () => {
        delete process.env.MOZART_TIMEOUT_MS;
        expect(getMozartTimeoutMs()).toBe(5_000);
    });

    it('returns custom value from env', () => {
        process.env.MOZART_TIMEOUT_MS = '2000';
        expect(getMozartTimeoutMs()).toBe(2_000);
    });

    it('falls back to 5000 for invalid value', () => {
        process.env.MOZART_TIMEOUT_MS = 'abc';
        expect(getMozartTimeoutMs()).toBe(5_000);
    });

    it('falls back to 5000 for zero', () => {
        process.env.MOZART_TIMEOUT_MS = '0';
        expect(getMozartTimeoutMs()).toBe(5_000);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// createMozartAdapter factory
// ──────────────────────────────────────────────────────────────────────────────

describe('createMozartAdapter', () => {
    afterEach(() => {
        delete process.env.MOZART_PROXY_URL;
        delete process.env.MOZART_TIMEOUT_MS;
    });

    it('returns stub adapter when MOZART_PROXY_URL is not set', () => {
        delete process.env.MOZART_PROXY_URL;
        const adapter = createMozartAdapter();
        expect(adapter.name).toBe('mozart-stub-v0');
    });

    it('returns HttpMozartAdapter when MOZART_PROXY_URL is set', () => {
        process.env.MOZART_PROXY_URL = 'http://localhost:9999';
        const adapter = createMozartAdapter();
        expect(adapter.name).toBe('mozart-http-v0');
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// HttpMozartAdapter.invoke
// ──────────────────────────────────────────────────────────────────────────────

describe('HttpMozartAdapter.invoke', () => {
    const adapter = new HttpMozartAdapter('http://localhost:9999', 1_000);

    const baseCall = {
        toolName: 'my_tool',
        args: { x: 1 },
        requestId: 'req-abc',
    };

    it('returns success=true with data on 200 OK JSON-RPC result', async () => {
        mockFetchOk({
            jsonrpc: '2.0',
            id: 'req-abc',
            result: { answer: 42 },
        });

        const result = await adapter.invoke(baseCall);

        expect(result.success).toBe(true);
        expect(result.data).toEqual({ answer: 42 });
        expect(result.error).toBeUndefined();
    });

    it('returns success=false when JSON-RPC error field is present', async () => {
        mockFetchOk({
            jsonrpc: '2.0',
            id: 'req-abc',
            error: { code: -32600, message: 'mcp_schema_mismatch' },
        });

        const result = await adapter.invoke(baseCall);

        expect(result.success).toBe(false);
        expect(result.error).toBe('mcp_schema_mismatch');
    });

    it('throws on HTTP 500 (triggers shim fallback)', async () => {
        mockFetchHttpError(500);

        await expect(adapter.invoke(baseCall)).rejects.toThrow('Mozart proxy HTTP 500');
    });

    it('throws on network error (triggers shim fallback)', async () => {
        mockFetchNetworkError('ECONNREFUSED');

        await expect(adapter.invoke(baseCall)).rejects.toThrow('Mozart proxy unreachable');
    });

    it('throws on timeout with descriptive message (FI-GAP-001 fix)', async () => {
        mockFetchTimeout();

        await expect(adapter.invoke(baseCall)).rejects.toThrow(/Mozart proxy timeout after \d+ms/);
    });

    it('sends correct JSON-RPC 2.0 body', async () => {
        mockFetchOk({ jsonrpc: '2.0', id: 'req-abc', result: {} });

        await adapter.invoke(baseCall);

        const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        const sentBody = JSON.parse(fetchCall[1].body as string);
        expect(sentBody.jsonrpc).toBe('2.0');
        expect(sentBody.method).toBe('tools/call');
        expect(sentBody.params.name).toBe('my_tool');
        expect(sentBody.params.arguments).toEqual({ x: 1 });
        expect(sentBody.id).toBe('req-abc');
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// HttpMozartAdapter.listTools
// ──────────────────────────────────────────────────────────────────────────────

describe('HttpMozartAdapter.listTools', () => {
    const adapter = new HttpMozartAdapter('http://localhost:9999', 1_000);

    it('returns array of tool names on success', async () => {
        mockFetchOk({
            jsonrpc: '2.0',
            id: 'list-tools',
            result: {
                tools: [
                    { name: 'tool_a', description: 'A' },
                    { name: 'tool_b', description: 'B' },
                ],
            },
        });

        const tools = await adapter.listTools();
        expect(tools).toEqual(['tool_a', 'tool_b']);
    });

    it('returns empty array when server returns JSON-RPC error', async () => {
        mockFetchOk({
            jsonrpc: '2.0',
            id: 'list-tools',
            error: { code: -32000, message: 'internal error' },
        });

        const tools = await adapter.listTools();
        expect(tools).toEqual([]);
    });

    it('throws on HTTP error (triggers shim fallback)', async () => {
        mockFetchHttpError(503);

        await expect(adapter.listTools()).rejects.toThrow('Mozart proxy HTTP 503');
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// HttpMozartAdapter.healthCheck
// ──────────────────────────────────────────────────────────────────────────────

describe('HttpMozartAdapter.healthCheck', () => {
    const adapter = new HttpMozartAdapter('http://localhost:9999', 1_000);

    it('returns true when proxy responds without error', async () => {
        mockFetchOk({ jsonrpc: '2.0', id: 'health-check', result: { ok: true } });

        const healthy = await adapter.healthCheck();
        expect(healthy).toBe(true);
    });

    it('returns false (does NOT throw) when proxy is down', async () => {
        mockFetchNetworkError('ECONNREFUSED');

        const healthy = await adapter.healthCheck();
        expect(healthy).toBe(false);
    });

    it('returns false when proxy returns HTTP error', async () => {
        mockFetchHttpError(500);

        const healthy = await adapter.healthCheck();
        expect(healthy).toBe(false);
    });
});
