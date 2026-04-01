import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const { mockCrossSpawn } = vi.hoisted(() => ({
    mockCrossSpawn: vi.fn(),
}));

vi.mock('cross-spawn', () => ({
    default: mockCrossSpawn,
}));

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCodexTransport, WindowsSafeStdioClientTransport } from './windowsSafeStdioClientTransport';

function makeChildProcess() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => child.emit('spawn'));
    return child;
}

describe('createCodexTransport', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        mockCrossSpawn.mockReset();
    });

    it('uses the Windows-safe transport on Windows', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockCrossSpawn.mockReturnValue(makeChildProcess());

        const transport = createCodexTransport({
            command: 'codex',
            args: ['mcp-server'],
            env: { PATH: process.env.PATH || '' },
        });

        expect(transport).toBeInstanceOf(WindowsSafeStdioClientTransport);
        await transport.start();

        expect(mockCrossSpawn).toHaveBeenCalledWith(
            'codex',
            ['mcp-server'],
            expect.objectContaining({
                windowsHide: true,
                shell: false,
            }),
        );
    });

    it('keeps the upstream transport on non-Windows platforms', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });

        const transport = createCodexTransport({
            command: 'codex',
            args: ['mcp-server'],
        });

        expect(transport).toBeInstanceOf(StdioClientTransport);
        expect(transport).not.toBeInstanceOf(WindowsSafeStdioClientTransport);
    });
});
