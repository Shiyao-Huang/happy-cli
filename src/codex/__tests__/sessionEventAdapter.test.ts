import { describe, expect, it } from 'vitest';

import {
    convertCodexAssistantEventToSessionMessage,
    createCodexAssistantEventReducerState,
    createCodexAssistantDeduper,
    extractCodexEventIdentity,
    hasSeenCodexAssistantMessage,
    reduceCodexAssistantEvent,
    rememberCodexAssistantMessage,
    resetCodexAssistantDeduper,
} from '../sessionEventAdapter';

describe('Codex assistant deduper', () => {
    it('treats identical assistant text from different event families as the same message', () => {
        const deduper = createCodexAssistantDeduper();
        const itemCompletedMessage = convertCodexAssistantEventToSessionMessage({
            type: 'item_completed',
            item: {
                type: 'AgentMessage',
                content: [{ type: 'Text', text: 'Bridge updated.' }],
            },
        });

        expect(itemCompletedMessage).not.toBeNull();
        expect(hasSeenCodexAssistantMessage(deduper, itemCompletedMessage!)).toBe(false);

        rememberCodexAssistantMessage(deduper, itemCompletedMessage!);

        expect(hasSeenCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'Bridge updated.',
        })).toBe(true);
    });

    it('keeps reasoning fingerprints separate from assistant message fingerprints', () => {
        const deduper = createCodexAssistantDeduper();

        rememberCodexAssistantMessage(deduper, {
            type: 'reasoning',
            message: 'Inspecting the adapter path',
        });

        expect(hasSeenCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'Inspecting the adapter path',
        })).toBe(false);
        expect(hasSeenCodexAssistantMessage(deduper, {
            type: 'reasoning',
            message: 'Inspecting the adapter path',
        })).toBe(true);
    });

    it('resets remembered fingerprints on a new task turn', () => {
        const deduper = createCodexAssistantDeduper();

        rememberCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'Turn one output',
        });
        expect(hasSeenCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'Turn one output',
        })).toBe(true);

        resetCodexAssistantDeduper(deduper);

        expect(hasSeenCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'Turn one output',
        })).toBe(false);
    });

    it('evicts the oldest fingerprints when the dedupe window is exceeded', () => {
        const deduper = createCodexAssistantDeduper(1);

        rememberCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'first',
        });
        rememberCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'second',
        });

        expect(hasSeenCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'first',
        })).toBe(false);
        expect(hasSeenCodexAssistantMessage(deduper, {
            type: 'message',
            message: 'second',
        })).toBe(true);
    });
});

describe('extractCodexEventIdentity', () => {
    it('extracts turn, call, and provider subagent linkage from mixed event field conventions', () => {
        expect(extractCodexEventIdentity({
            type: 'agent_message',
            turn_id: 'turn-1',
            call_id: 'call-1',
            parent_call_id: 'parent-tool-1',
        })).toEqual({
            rawEventType: 'agent_message',
            turnId: 'turn-1',
            callId: 'call-1',
            providerSubagentId: 'parent-tool-1',
        });

        expect(extractCodexEventIdentity({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call_output',
                turnId: 'turn-2',
                callId: 'call-2',
                parentCallId: 'parent-tool-2',
            },
        })).toEqual({
            rawEventType: 'custom_tool_call_output',
            turnId: 'turn-2',
            callId: 'call-2',
            providerSubagentId: 'parent-tool-2',
        });
    });
});

describe('reduceCodexAssistantEvent', () => {
    it('replays delta -> agent_message -> item_completed without duplicating assistant output', () => {
        const state = createCodexAssistantEventReducerState();

        reduceCodexAssistantEvent(state, { type: 'task_started' });
        expect(reduceCodexAssistantEvent(state, {
            type: 'agent_message_delta',
            delta: 'Bridge ',
        }).emitted).toEqual([]);
        expect(reduceCodexAssistantEvent(state, {
            type: 'agent_message',
            message: 'updated.',
        }).emitted).toMatchObject([
            {
                type: 'message',
                message: 'Bridge ',
            },
        ]);
        expect(reduceCodexAssistantEvent(state, {
            type: 'item_completed',
            item: {
                type: 'AgentMessage',
                content: [{ type: 'Text', text: 'Bridge ' }],
            },
        })).toMatchObject({
            emitted: [],
            skippedReason: 'assistant event duplicated previously emitted content',
        });
    });

    it('emits item_completed assistant output when no earlier agent_message arrived', () => {
        const state = createCodexAssistantEventReducerState();

        reduceCodexAssistantEvent(state, { type: 'task_started' });
        const result = reduceCodexAssistantEvent(state, {
            type: 'item_completed',
            item: {
                type: 'AgentMessage',
                content: [{ type: 'Text', text: 'Fallback final answer' }],
            },
        });

        expect(result.emitted).toMatchObject([
            {
                type: 'message',
                message: 'Fallback final answer',
            },
        ]);
    });

    it('flushes buffered deltas on task completion when no closing agent_message exists', () => {
        const state = createCodexAssistantEventReducerState();

        reduceCodexAssistantEvent(state, { type: 'task_started' });
        reduceCodexAssistantEvent(state, {
            type: 'agent_message_delta',
            delta: 'Buffered tail',
        });
        const result = reduceCodexAssistantEvent(state, {
            type: 'task_complete',
        });

        expect(result.emitted).toMatchObject([
            {
                type: 'message',
                message: 'Buffered tail',
            },
        ]);
        expect(state.agentMessageDeltaBuffer).toBe('');
    });

    it('dedupes repeated reasoning summaries coming from item_completed', () => {
        const state = createCodexAssistantEventReducerState();

        reduceCodexAssistantEvent(state, { type: 'task_started' });
        const first = reduceCodexAssistantEvent(state, {
            type: 'item_completed',
            item: {
                type: 'Reasoning',
                summary_text: [{ text: 'Comparing adapter paths' }],
            },
        });
        const second = reduceCodexAssistantEvent(state, {
            type: 'item_completed',
            item: {
                type: 'Reasoning',
                summary_text: [{ text: 'Comparing adapter paths' }],
            },
        });

        expect(first.emitted).toMatchObject([
            {
                type: 'reasoning',
                message: 'Comparing adapter paths',
            },
        ]);
        expect(second).toMatchObject({
            emitted: [],
            skippedReason: 'assistant event duplicated previously emitted content',
        });
    });

    it('reports non-assistant item_completed events as skipped instead of silently ignoring them', () => {
        const state = createCodexAssistantEventReducerState();

        reduceCodexAssistantEvent(state, { type: 'task_started' });
        const result = reduceCodexAssistantEvent(state, {
            type: 'item_completed',
            item: {
                type: 'ToolResult',
            },
        });

        expect(result).toEqual({
            emitted: [],
            skippedReason: 'item_completed had no assistant payload to forward',
        });
    });
});
