/**
 * Bridge Tool Tests — Unified tool invocation bridge validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerBridgeTools } from './bridgeTools';
import { invokeMozartTool, checkMozartAvailable } from './mozartBridge';

// Mock mozartBridge
vi.mock('./mozartBridge', () => ({
    invokeMozartTool: vi.fn(),
    checkMozartAvailable: vi.fn(),
}));

// Mock logger
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

describe('registerBridgeTools', () => {
    let registeredTools: Map<string, { config: any; handler: any }>;
    let mockMcp: { registerTool: (name: string, config: any, handler: any) => void };

    beforeEach(() => {
        vi.clearAllMocks();
        registeredTools = new Map();
        mockMcp = {
            registerTool: (name: string, config: any, handler: any) => {
                registeredTools.set(name, { config, handler });
            },
        };
        registerBridgeTools(mockMcp);
    });

    it('registers invoke_tool and check_bridge tools', () => {
        expect(registeredTools.has('invoke_tool')).toBe(true);
        expect(registeredTools.has('check_bridge')).toBe(true);
    });

    describe('invoke_tool', () => {
        it('returns successful result as JSON', async () => {
            vi.mocked(invokeMozartTool).mockResolvedValue({
                success: true,
                data: { tasks: ['task1', 'task2'] },
                metadata: { latencyMs: 50, adapter: 'mozart-cli' },
            });

            const handler = registeredTools.get('invoke_tool')!.handler;
            const result = await handler({
                tool_name: 'list_tasks',
                arguments: { status: 'active' },
            });

            expect(result.isError).toBeUndefined();
            const text = result.content[0].text;
            expect(JSON.parse(text)).toEqual({ tasks: ['task1', 'task2'] });
        });

        it('passes tool name and arguments to bridge', async () => {
            vi.mocked(invokeMozartTool).mockResolvedValue({
                success: true,
                data: null,
            });

            const handler = registeredTools.get('invoke_tool')!.handler;
            await handler({
                tool_name: 'send_team_message',
                arguments: { content: 'hello' },
                request_id: 'req-123',
            });

            expect(invokeMozartTool).toHaveBeenCalledWith(
                {
                    toolName: 'send_team_message',
                    arguments: { content: 'hello' },
                    requestId: 'req-123',
                },
                undefined,
            );
        });

        it('handles invocation failure', async () => {
            vi.mocked(invokeMozartTool).mockResolvedValue({
                success: false,
                error: 'Tool not found: nonexistent',
                metadata: { latencyMs: 10, adapter: 'mozart-cli', fallbackReason: 'non-zero-exit-code' },
            });

            const handler = registeredTools.get('invoke_tool')!.handler;
            const result = await handler({
                tool_name: 'nonexistent',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Tool not found');
        });

        it('defaults arguments to empty object', async () => {
            vi.mocked(invokeMozartTool).mockResolvedValue({
                success: true,
                data: null,
            });

            const handler = registeredTools.get('invoke_tool')!.handler;
            await handler({ tool_name: 'test' });

            expect(invokeMozartTool).toHaveBeenCalledWith(
                expect.objectContaining({ arguments: {} }),
                undefined,
            );
        });

        it('rejects recursive bridge tool names', async () => {
            const handler = registeredTools.get('invoke_tool')!.handler;

            const result = await handler({ tool_name: 'invoke_tool' });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('recursive call');
            expect(invokeMozartTool).not.toHaveBeenCalled();
        });
    });

    describe('check_bridge', () => {
        it('reports healthy when available', async () => {
            vi.mocked(checkMozartAvailable).mockResolvedValue(true);

            const handler = registeredTools.get('check_bridge')!.handler;
            const result = await handler({});

            const text = result.content[0].text;
            const parsed = JSON.parse(text);
            expect(parsed.available).toBe(true);
            expect(parsed.status).toBe('healthy');
            expect(parsed.bridgeType).toBe('mozart-cli');
        });

        it('reports unavailable when not available', async () => {
            vi.mocked(checkMozartAvailable).mockResolvedValue(false);

            const handler = registeredTools.get('check_bridge')!.handler;
            const result = await handler({});

            const text = result.content[0].text;
            const parsed = JSON.parse(text);
            expect(parsed.available).toBe(false);
            expect(parsed.status).toBe('unavailable');
        });
    });
});
