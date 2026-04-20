/**
 * @module mozartShim.test
 * @description TDD tests for the Mozart MCP shim.
 *
 * Coverage:
 * - P0: flag=off → passthrough (zero behavior change)
 * - P0: flag=on  → Mozart stub invoked, returns original result
 * - P0: flag=on + Mozart error → fallback to original handler
 * - P0: flag=on + Mozart AND original both fail → propagate original error
 * - Structured log shape (trace_id / adapter / latency_ms / result / fallback_reason)
 * - createStubMozartAdapter smoke test
 * - patchRegisterTool integration smoke test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    isMozartEnabled,
    wrapWithMozart,
    createStubMozartAdapter,
    patchRegisterTool,
    type MozartAdapter,
    type MozartToolCall,
    type MozartAdapterResult,
    type ShimLog,
} from './mozartShim';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeFakeAdapter(overrides?: Partial<MozartAdapter>): MozartAdapter {
    return {
        name: 'fake-adapter',
        invoke: vi.fn().mockResolvedValue({ success: true, data: { from: 'mozart' } }),
        listTools: vi.fn().mockResolvedValue([]),
        healthCheck: vi.fn().mockResolvedValue(true),
        ...overrides,
    };
}

function makeOriginalHandler<T = unknown>(returnValue: T) {
    return vi.fn().mockResolvedValue(returnValue);
}

// Capture logger.debug calls to verify structured logs
const capturedLogs: string[] = [];

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: (msg: string) => capturedLogs.push(msg),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// ──────────────────────────────────────────────────────────────────────────────
// Feature flag
// ──────────────────────────────────────────────────────────────────────────────

describe('isMozartEnabled', () => {
    afterEach(() => {
        delete process.env.MOZART_ENABLED;
    });

    it('returns false when MOZART_ENABLED is not set', () => {
        delete process.env.MOZART_ENABLED;
        expect(isMozartEnabled()).toBe(false);
    });

    it('returns false when MOZART_ENABLED=0', () => {
        process.env.MOZART_ENABLED = '0';
        expect(isMozartEnabled()).toBe(false);
    });

    it('returns false when MOZART_ENABLED=false', () => {
        process.env.MOZART_ENABLED = 'false';
        expect(isMozartEnabled()).toBe(false);
    });

    it('returns true when MOZART_ENABLED=1', () => {
        process.env.MOZART_ENABLED = '1';
        expect(isMozartEnabled()).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// createStubMozartAdapter
// ──────────────────────────────────────────────────────────────────────────────

describe('createStubMozartAdapter', () => {
    it('has name mozart-stub-v0', () => {
        const adapter = createStubMozartAdapter();
        expect(adapter.name).toBe('mozart-stub-v0');
    });

    it('invoke returns success=true with stub data', async () => {
        const adapter = createStubMozartAdapter();
        const result = await adapter.invoke({
            toolName: 'test_tool',
            args: { foo: 'bar' },
            requestId: 'req-123',
        });
        expect(result.success).toBe(true);
        expect((result.data as any).__stub__).toBe(true);
        expect((result.data as any).toolName).toBe('test_tool');
    });

    it('listTools returns empty array', async () => {
        const adapter = createStubMozartAdapter();
        const tools = await adapter.listTools();
        expect(tools).toEqual([]);
    });

    it('healthCheck returns true', async () => {
        const adapter = createStubMozartAdapter();
        const healthy = await adapter.healthCheck();
        expect(healthy).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// wrapWithMozart — passthrough (flag off)
// ──────────────────────────────────────────────────────────────────────────────

describe('wrapWithMozart — flag=off (passthrough)', () => {
    beforeEach(() => {
        capturedLogs.length = 0;
        delete process.env.MOZART_ENABLED;
    });

    afterEach(() => {
        delete process.env.MOZART_ENABLED;
    });

    it('calls original handler and returns its result', async () => {
        const original = makeOriginalHandler({ ok: true });
        const adapter = makeFakeAdapter();
        const wrapped = wrapWithMozart('my_tool', original, adapter);

        const result = await wrapped({ x: 1 });

        expect(result).toEqual({ ok: true });
        expect(original).toHaveBeenCalledOnce();
        expect(original).toHaveBeenCalledWith({ x: 1 });
    });

    it('does NOT call adapter.invoke when flag is off', async () => {
        const original = makeOriginalHandler('hello');
        const adapter = makeFakeAdapter();
        const wrapped = wrapWithMozart('my_tool', original, adapter);

        await wrapped({});

        expect(adapter.invoke).not.toHaveBeenCalled();
    });

    it('emits passthrough log', async () => {
        const original = makeOriginalHandler('res');
        const adapter = makeFakeAdapter();
        const wrapped = wrapWithMozart('some_tool', original, adapter);

        await wrapped({});

        const shimLog = capturedLogs.find((l) => l.includes('[mozartShim]') && l.includes('passthrough'));
        expect(shimLog).toBeDefined();

        const parsed = JSON.parse(shimLog!.replace('[mozartShim] ', '')) as ShimLog;
        expect(parsed.result).toBe('passthrough');
        expect(parsed.adapter).toBe('none');
        expect(typeof parsed.trace_id).toBe('string');
        expect(typeof parsed.latency_ms).toBe('number');
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// wrapWithMozart — Mozart path (flag=1, success)
// ──────────────────────────────────────────────────────────────────────────────

describe('wrapWithMozart — flag=1 (Mozart success)', () => {
    beforeEach(() => {
        capturedLogs.length = 0;
        process.env.MOZART_ENABLED = '1';
    });

    afterEach(() => {
        delete process.env.MOZART_ENABLED;
    });

    it('invokes Mozart adapter and still returns original handler result (Phase-1 passthrough)', async () => {
        const originalResult = { content: [{ type: 'text', text: 'done' }] };
        const original = makeOriginalHandler(originalResult);
        const adapter = makeFakeAdapter();
        const wrapped = wrapWithMozart('my_tool', original, adapter);

        const result = await wrapped({ arg: 'val' });

        // Phase-1: original handler result is returned (stub doesn't replace output)
        expect(result).toEqual(originalResult);
        expect(adapter.invoke).toHaveBeenCalledOnce();
    });

    it('passes correct toolName and args to adapter.invoke', async () => {
        const original = makeOriginalHandler(null);
        const adapter = makeFakeAdapter();
        const wrapped = wrapWithMozart('specific_tool', original, adapter);

        await wrapped({ hello: 'world' });

        const call = (adapter.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as MozartToolCall;
        expect(call.toolName).toBe('specific_tool');
        expect(call.args).toEqual({ hello: 'world' });
        expect(typeof call.requestId).toBe('string');
    });

    it('emits mozart log with trace_id, adapter, latency_ms', async () => {
        const original = makeOriginalHandler('ok');
        const adapter = makeFakeAdapter();
        const wrapped = wrapWithMozart('my_tool', original, adapter);

        await wrapped({});

        const shimLog = capturedLogs.find((l) => l.includes('[mozartShim]') && l.includes('"result":"mozart"'));
        expect(shimLog).toBeDefined();

        const parsed = JSON.parse(shimLog!.replace('[mozartShim] ', '')) as ShimLog;
        expect(parsed.result).toBe('mozart');
        expect(parsed.adapter).toBe('fake-adapter');
        expect(typeof parsed.trace_id).toBe('string');
        expect(typeof parsed.latency_ms).toBe('number');
        expect(parsed.fallback_reason).toBeUndefined();
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// wrapWithMozart — fallback (Mozart fails)
// ──────────────────────────────────────────────────────────────────────────────

describe('wrapWithMozart — flag=1 (Mozart failure → fallback)', () => {
    beforeEach(() => {
        capturedLogs.length = 0;
        process.env.MOZART_ENABLED = '1';
    });

    afterEach(() => {
        delete process.env.MOZART_ENABLED;
    });

    it('falls back to original handler when adapter.invoke throws', async () => {
        const originalResult = { fallback: true };
        const original = makeOriginalHandler(originalResult);
        const adapter = makeFakeAdapter({
            invoke: vi.fn().mockRejectedValue(new Error('adapter_invoke_timeout')),
        });
        const wrapped = wrapWithMozart('my_tool', original, adapter);

        const result = await wrapped({ x: 1 });

        expect(result).toEqual(originalResult);
        expect(original).toHaveBeenCalledOnce();
    });

    it('falls back when adapter returns success=false', async () => {
        const originalResult = { fallback: true };
        const original = makeOriginalHandler(originalResult);
        const adapter = makeFakeAdapter({
            invoke: vi.fn().mockResolvedValue({ success: false, data: null, error: 'mcp_schema_mismatch' }),
        });
        const wrapped = wrapWithMozart('my_tool', original, adapter);

        const result = await wrapped({});

        expect(result).toEqual(originalResult);
        expect(original).toHaveBeenCalledOnce();
    });

    it('emits fallback log with fallback_reason', async () => {
        const original = makeOriginalHandler('ok');
        const adapter = makeFakeAdapter({
            invoke: vi.fn().mockRejectedValue(new Error('adapter_runtime_panic')),
        });
        const wrapped = wrapWithMozart('my_tool', original, adapter);

        await wrapped({});

        const shimLog = capturedLogs.find((l) => l.includes('[mozartShim]') && l.includes('"result":"fallback"'));
        expect(shimLog).toBeDefined();

        const parsed = JSON.parse(shimLog!.replace('[mozartShim] ', '')) as ShimLog;
        expect(parsed.result).toBe('fallback');
        expect(parsed.fallback_reason).toContain('adapter_runtime_panic');
        expect(typeof parsed.trace_id).toBe('string');
    });

    it('propagates original handler error when both paths fail', async () => {
        const originalError = new Error('original_handler_error');
        const original = vi.fn().mockRejectedValue(originalError);
        const adapter = makeFakeAdapter({
            invoke: vi.fn().mockRejectedValue(new Error('mozart_error')),
        });
        const wrapped = wrapWithMozart('my_tool', original, adapter);

        await expect(wrapped({})).rejects.toThrow('original_handler_error');
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// patchRegisterTool
// ──────────────────────────────────────────────────────────────────────────────

describe('patchRegisterTool', () => {
    beforeEach(() => {
        capturedLogs.length = 0;
        delete process.env.MOZART_ENABLED;
    });

    it('calls originalRegisterTool with the tool name and config', () => {
        const originalRegisterTool = vi.fn();
        const patched = patchRegisterTool(originalRegisterTool);

        const handler = vi.fn().mockResolvedValue('result');
        patched('some_tool', { description: 'A tool' }, handler);

        expect(originalRegisterTool).toHaveBeenCalledOnce();
        expect(originalRegisterTool.mock.calls[0][0]).toBe('some_tool');
        expect(originalRegisterTool.mock.calls[0][1]).toEqual({ description: 'A tool' });
    });

    it('wraps the handler so the original is still called', async () => {
        let registeredHandler: ((args: unknown) => Promise<unknown>) | null = null;
        const originalRegisterTool = vi.fn((_name, _config, h) => {
            registeredHandler = h;
        });

        const original = makeOriginalHandler({ done: true });
        const patched = patchRegisterTool(originalRegisterTool);
        patched('tool_x', {}, original);

        const result = await registeredHandler!({ a: 1 });
        expect(result).toEqual({ done: true });
        expect(original).toHaveBeenCalledWith({ a: 1 });
    });
});
