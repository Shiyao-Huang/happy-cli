import { describe, expect, it, vi } from 'vitest';
import { CodexMcpClient, parseCodexApprovalRequest } from '../codexMcpClient';

describe('parseCodexApprovalRequest', () => {
    it('parses legacy exec approval requests', () => {
        expect(parseCodexApprovalRequest({
            message: 'Allow command?',
            codex_elicitation: 'exec_command',
            codex_call_id: 'call_exec',
            codex_command: ['pwd'],
            codex_cwd: '/tmp/workspace'
        })).toEqual({
            requestId: 'call_exec',
            toolCallId: 'call_exec',
            toolName: 'CodexBash',
            input: {
                command: ['pwd'],
                cwd: '/tmp/workspace',
                message: 'Allow command?'
            },
            approvalKind: 'exec_command'
        });
    });

    it('parses real MCP tool approval events from codex-cli 0.117.0', () => {
        expect(parseCodexApprovalRequest({
            type: 'elicitation_request',
            turn_id: '1',
            server_name: 'testbridge',
            id: 'mcp_tool_call_approval_call_real123',
            request: {
                mode: 'form',
                _meta: {
                    codex_approval_kind: 'mcp_tool_call',
                    persist: ['session', 'always'],
                    tool_description: 'Echo the provided text back exactly.',
                    tool_params: { text: 'hello bridge' },
                },
                message: 'Allow the testbridge MCP server to run tool "echo_text"?',
                requested_schema: {
                    type: 'object',
                    properties: {}
                }
            }
        })).toEqual({
            requestId: 'mcp_tool_call_approval_call_real123',
            toolCallId: 'call_real123',
            toolName: 'mcp__testbridge__echo_text',
            input: {
                server: 'testbridge',
                tool: 'echo_text',
                arguments: { text: 'hello bridge' },
                toolDescription: 'Echo the provided text back exactly.',
                persist: ['session', 'always'],
                message: 'Allow the testbridge MCP server to run tool "echo_text"?'
            },
            approvalKind: 'mcp_tool_call'
        });
    });
});

describe('CodexMcpClient threadId compatibility', () => {
    it('extracts threadId as the active session identifier', () => {
        const client = new CodexMcpClient() as any;

        client.extractIdentifiers({
            structuredContent: {
                threadId: 'thread_123'
            }
        });

        expect(client.getSessionId()).toBe('thread_123');
        expect(client.conversationId).toBe('thread_123');
    });

    it('continues sessions using threadId for codex-reply', async () => {
        const client = new CodexMcpClient() as any;
        const callTool = vi.fn().mockResolvedValue({ structuredContent: { threadId: 'thread_123' } });

        client.connected = true;
        client.sessionId = 'thread_123';
        client.conversationId = 'thread_123';
        client.client = { callTool };

        await client.continueSession('next prompt');

        expect(callTool).toHaveBeenCalledWith({
            name: 'codex-reply',
            arguments: {
                threadId: 'thread_123',
                conversationId: 'thread_123',
                prompt: 'next prompt'
            }
        }, undefined, expect.objectContaining({
            timeout: expect.any(Number)
        }));
    });
});
