import { describe, expect, it } from 'vitest';
import {
    convertCodexApprovalEventToSessionMessage,
    convertCodexAssistantEventToSessionMessage,
    convertCodexFunctionEventToSessionMessage,
    convertCodexMcpLifecycleEventToSessionMessage,
    unwrapCodexEvent,
} from '../sessionEventAdapter';

describe('unwrapCodexEvent', () => {
    it('unwraps raw_response_item notifications from newer codex MCP servers', () => {
        const raw = {
            type: 'raw_response_item',
            item: {
                type: 'function_call',
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}',
                call_id: 'call_raw'
            }
        };

        expect(unwrapCodexEvent(raw)).toEqual(raw.item);
    });

    it('unwraps response_item payloads from newer codex transcripts', () => {
        const raw = {
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'mcp__aha__change_title',
                arguments: '{"title":"x"}',
                call_id: 'call_123'
            }
        };

        expect(unwrapCodexEvent(raw)).toEqual(raw.payload);
    });

    it('passes through legacy direct events unchanged', () => {
        const raw = {
            type: 'agent_message',
            message: 'done'
        };

        expect(unwrapCodexEvent(raw)).toEqual(raw);
    });
});

describe('convertCodexFunctionEventToSessionMessage', () => {
    it('converts function_call events into tool-call session messages', () => {
        const message = convertCodexFunctionEventToSessionMessage({
            type: 'function_call',
            name: 'mcp__aha__change_title',
            arguments: '{"title":"新标题"}',
            call_id: 'call_abc'
        });

        expect(message).toMatchObject({
            type: 'tool-call',
            name: 'mcp__aha__change_title',
            callId: 'call_abc',
            input: {
                title: '新标题'
            }
        });
        expect(message?.id).toEqual(expect.any(String));
    });

    it('converts function_call_output events into tool-call-result session messages', () => {
        const message = convertCodexFunctionEventToSessionMessage({
            type: 'function_call_output',
            call_id: 'call_abc',
            output: '[{"type":"text","text":"ok"}]'
        });

        expect(message).toMatchObject({
            type: 'tool-call-result',
            callId: 'call_abc',
            output: [
                {
                    type: 'text',
                    text: 'ok'
                }
            ]
        });
        expect(message?.id).toEqual(expect.any(String));
    });

    it('keeps non-json arguments as raw strings', () => {
        const message = convertCodexFunctionEventToSessionMessage({
            type: 'function_call',
            name: 'mcp__aha__send_team_message',
            arguments: 'plain text payload',
            call_id: 'call_plain'
        });

        expect(message).toMatchObject({
            type: 'tool-call',
            name: 'mcp__aha__send_team_message',
            callId: 'call_plain',
            input: 'plain text payload'
        });
    });

    it('converts custom_tool_call events into tool-call session messages', () => {
        const message = convertCodexFunctionEventToSessionMessage({
            type: 'raw_response_item',
            item: {
                type: 'custom_tool_call',
                name: 'apply_patch',
                input: '*** Begin Patch',
                call_id: 'call_patch'
            }
        });

        expect(message).toMatchObject({
            type: 'tool-call',
            name: 'apply_patch',
            callId: 'call_patch',
            input: '*** Begin Patch'
        });
        expect(message?.id).toEqual(expect.any(String));
    });

    it('converts custom_tool_call_output events into parsed tool-call-result messages', () => {
        const message = convertCodexFunctionEventToSessionMessage({
            type: 'raw_response_item',
            item: {
                type: 'custom_tool_call_output',
                call_id: 'call_patch',
                output: '{"output":"Success","metadata":{"exit_code":0}}'
            }
        });

        expect(message).toMatchObject({
            type: 'tool-call-result',
            callId: 'call_patch',
            output: {
                output: 'Success',
                metadata: {
                    exit_code: 0
                }
            }
        });
        expect(message?.id).toEqual(expect.any(String));
    });
});

describe('convertCodexAssistantEventToSessionMessage', () => {
    it('converts raw assistant message items into session messages', () => {
        const message = convertCodexAssistantEventToSessionMessage({
            type: 'raw_response_item',
            item: {
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'output_text', text: 'Hello ' },
                    { type: 'output_text', text: 'world' }
                ]
            }
        });

        expect(message).toMatchObject({
            type: 'message',
            message: 'Hello world',
        });
        expect(message?.id).toEqual(expect.any(String));
    });

    it('converts item_completed AgentMessage events into session messages', () => {
        const message = convertCodexAssistantEventToSessionMessage({
            type: 'item_completed',
            item: {
                type: 'AgentMessage',
                content: [
                    { type: 'Text', text: 'Done.' }
                ]
            }
        });

        expect(message).toMatchObject({
            type: 'message',
            message: 'Done.',
        });
        expect(message?.id).toEqual(expect.any(String));
    });

    it('ignores raw message items that are not assistant output', () => {
        const message = convertCodexAssistantEventToSessionMessage({
            type: 'raw_response_item',
            item: {
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_text', text: 'system prompt' }
                ]
            }
        });

        expect(message).toBeNull();
    });

    it('converts raw reasoning summaries into reasoning messages when summary text exists', () => {
        const message = convertCodexAssistantEventToSessionMessage({
            type: 'raw_response_item',
            item: {
                type: 'reasoning',
                summary: [
                    { text: 'Investigating model routing mismatch' }
                ]
            }
        });

        expect(message).toMatchObject({
            type: 'reasoning',
            message: 'Investigating model routing mismatch',
        });
        expect(message?.id).toEqual(expect.any(String));
    });

    it('converts item_completed Reasoning events when summary_text exists', () => {
        const message = convertCodexAssistantEventToSessionMessage({
            type: 'item_completed',
            item: {
                type: 'Reasoning',
                summary_text: [
                    { text: 'Comparing possible rollback paths' }
                ]
            }
        });

        expect(message).toMatchObject({
            type: 'reasoning',
            message: 'Comparing possible rollback paths',
        });
        expect(message?.id).toEqual(expect.any(String));
    });
});

describe('convertCodexMcpLifecycleEventToSessionMessage', () => {
    it('converts mcp_tool_call_begin into tool-call session messages', () => {
        const message = convertCodexMcpLifecycleEventToSessionMessage({
            type: 'mcp_tool_call_begin',
            call_id: 'call_mcp',
            invocation: {
                server: 'aha',
                tool: 'change_title',
                arguments: { title: 'Hello' }
            }
        });

        expect(message).toMatchObject({
            type: 'tool-call',
            name: 'change_title',
            callId: 'call_mcp',
            input: { title: 'Hello' }
        });
    });

    it('converts mcp_tool_call_end into tool-call-result session messages', () => {
        const message = convertCodexMcpLifecycleEventToSessionMessage({
            type: 'mcp_tool_call_end',
            call_id: 'call_mcp',
            invocation: {
                server: 'aha',
                tool: 'change_title',
                arguments: { title: 'Hello' }
            },
            result: {
                Ok: {
                    content: [{ type: 'text', text: 'ok' }],
                    isError: false
                }
            }
        });

        expect(message).toMatchObject({
            type: 'tool-call-result',
            callId: 'call_mcp',
            output: {
                content: [{ type: 'text', text: 'ok' }],
                isError: false
            }
        });
    });
});

describe('convertCodexApprovalEventToSessionMessage', () => {
    it('converts real elicitation_request events into approval tool-call session messages', () => {
        const message = convertCodexApprovalEventToSessionMessage({
            type: 'elicitation_request',
            turn_id: '1',
            server_name: 'testbridge',
            id: 'mcp_tool_call_approval_call_P7JpgLPJgs8EGodLzrWd7VmU',
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
        });

        expect(message).toMatchObject({
            type: 'tool-call',
            name: 'CodexApprovalRequest',
            callId: 'approval:call_P7JpgLPJgs8EGodLzrWd7VmU',
            input: {
                toolCallId: 'call_P7JpgLPJgs8EGodLzrWd7VmU',
                toolName: 'mcp__testbridge__echo_text',
                approvalKind: 'mcp_tool_call',
                server: 'testbridge',
                tool: 'echo_text',
                arguments: { text: 'hello bridge' },
                toolDescription: 'Echo the provided text back exactly.',
            }
        });
        expect(message?.id).toEqual(expect.any(String));
    });
});
