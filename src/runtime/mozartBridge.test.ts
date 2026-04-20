/**
 * Mozart Bridge Tests — Bash CLI wrapper validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeMozartTool, checkMozartAvailable, getMozartVersion } from './mozartBridge';
import type { ToolInvocation } from './types';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// Mock child_process.spawn
vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

// Mock logger
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

import { spawn } from 'node:child_process';

function createMockChildProcess(options: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    error?: Error;
}): ChildProcess {
    const cp = new EventEmitter() as ChildProcess;
    (cp as any).stdout = new EventEmitter();
    (cp as any).stderr = new EventEmitter();
    (cp as any).stdin = null;

    // Simulate process lifecycle
    setTimeout(() => {
        if (options.error) {
            cp.emit('error', options.error);
            return;
        }

        if (options.stdout) {
            (cp as any).stdout.emit('data', Buffer.from(options.stdout));
        }
        if (options.stderr) {
            (cp as any).stderr.emit('data', Buffer.from(options.stderr));
        }

        cp.emit('close', options.exitCode ?? 0);
    }, 0);

    return cp;
}

describe('invokeMozartTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('invokes tool with correct CLI args', async () => {
        const mockCp = createMockChildProcess({
            stdout: '{"result": "success"}',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const invocation: ToolInvocation = {
            toolName: 'list_tasks',
            arguments: { status: 'active' },
        };

        const result = await invokeMozartTool(invocation);

        expect(spawn).toHaveBeenCalledWith(
            'mozart',
            expect.arrayContaining([
                'invoke',
                '--tool', 'list_tasks',
                '--payload', JSON.stringify({ status: 'active' }),
            ]),
            expect.any(Object)
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual({ result: 'success' });
    });

    it('passes MCP URL when configured', async () => {
        const mockCp = createMockChildProcess({
            stdout: '{"tools": []}',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        await invokeMozartTool(
            { toolName: 'test', arguments: {} },
            { mcpUrl: 'http://localhost:3006' }
        );

        expect(spawn).toHaveBeenCalledWith(
            'mozart',
            expect.arrayContaining(['--mcp-url', 'http://localhost:3006']),
            expect.any(Object)
        );
    });

    it('uses custom mozartPath when provided', async () => {
        const mockCp = createMockChildProcess({
            stdout: '{}',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        await invokeMozartTool(
            { toolName: 'test', arguments: {} },
            { mozartPath: '/usr/local/bin/mozart' }
        );

        expect(spawn).toHaveBeenCalledWith(
            '/usr/local/bin/mozart',
            expect.any(Array),
            expect.any(Object)
        );
    });

    it('returns error on non-zero exit code', async () => {
        const mockCp = createMockChildProcess({
            stderr: 'Tool not found',
            exitCode: 1,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const result = await invokeMozartTool({
            toolName: 'nonexistent',
            arguments: {},
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Tool not found');
        expect(result.metadata?.fallbackReason).toBe('non-zero-exit-code');
    });

    it('returns error on spawn error', async () => {
        const mockCp = createMockChildProcess({
            error: new Error('ENOENT: mozart not found'),
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const result = await invokeMozartTool({
            toolName: 'test',
            arguments: {},
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('ENOENT');
        expect(result.metadata?.fallbackReason).toBe('spawn-error');
    });

    it('handles non-JSON output gracefully', async () => {
        const mockCp = createMockChildProcess({
            stdout: 'plain text output',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const result = await invokeMozartTool({
            toolName: 'test',
            arguments: {},
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual({ output: 'plain text output' });
    });

    it('includes latency metadata', async () => {
        const mockCp = createMockChildProcess({
            stdout: '{}',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const result = await invokeMozartTool({
            toolName: 'test',
            arguments: {},
        });

        expect(result.metadata?.latencyMs).toBeGreaterThanOrEqual(0);
        expect(result.metadata?.adapter).toBe('mozart-cli');
    });

    it('passes remote URL when configured', async () => {
        const mockCp = createMockChildProcess({
            stdout: '{}',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        await invokeMozartTool(
            { toolName: 'test', arguments: {} },
            { remoteUrl: 'http://remote.example.com/api' }
        );

        expect(spawn).toHaveBeenCalledWith(
            'mozart',
            expect.arrayContaining(['--remote-url', 'http://remote.example.com/api']),
            expect.any(Object)
        );
    });

    it('handles empty stdout', async () => {
        const mockCp = createMockChildProcess({
            stdout: '',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const result = await invokeMozartTool({
            toolName: 'test',
            arguments: {},
        });

        expect(result.success).toBe(true);
        expect(result.data).toBeNull();
    });
});

describe('checkMozartAvailable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns true when mozart is available', async () => {
        const mockCp = createMockChildProcess({
            stdout: 'mozart 0.1.0',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const available = await checkMozartAvailable();
        expect(available).toBe(true);
    });

    it('returns false when mozart is not available', async () => {
        const mockCp = createMockChildProcess({
            error: new Error('ENOENT'),
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const available = await checkMozartAvailable();
        expect(available).toBe(false);
    });
});

describe('getMozartVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns version string on success', async () => {
        const mockCp = createMockChildProcess({
            stdout: 'mozart 0.1.0\n',
            exitCode: 0,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const version = await getMozartVersion();
        expect(version).toBe('mozart 0.1.0');
    });

    it('returns null on failure', async () => {
        const mockCp = createMockChildProcess({
            exitCode: 1,
        });
        vi.mocked(spawn).mockReturnValue(mockCp);

        const version = await getMozartVersion();
        expect(version).toBeNull();
    });
});
