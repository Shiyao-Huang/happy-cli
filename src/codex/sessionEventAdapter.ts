import { randomUUID } from 'node:crypto';

import { parseCodexApprovalRequest } from './codexMcpClient';

export type CodexAssistantSessionMessage =
    | {
        type: 'message';
        message: string;
        id?: string;
    }
    | {
        type: 'reasoning';
        message: string;
        id?: string;
    };

export type CodexAssistantDeduperState = {
    maxRecent: number;
    recentFingerprints: string[];
    seenFingerprints: Set<string>;
};

export type CodexAssistantEventReducerState = {
    deduper: CodexAssistantDeduperState;
    agentMessageDeltaBuffer: string;
};

export type CodexAssistantEventReducerResult = {
    emitted: CodexAssistantSessionMessage[];
    skippedReason?: string;
};

export type CodexEventIdentity = {
    rawEventType: string | null;
    turnId?: string;
    callId?: string;
    providerSubagentId?: string;
};

function parseStructuredCodexValue(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return value;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}

function normalizeAssistantText(text: string): string | null {
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function buildAssistantFingerprint(message: CodexAssistantSessionMessage): string | null {
    const normalized = normalizeAssistantText(message.message);
    if (!normalized) {
        return null;
    }

    return `${message.type}:${normalized}`;
}

export function createCodexAssistantDeduper(maxRecent: number = 64): CodexAssistantDeduperState {
    return {
        maxRecent,
        recentFingerprints: [],
        seenFingerprints: new Set<string>(),
    };
}

export function hasSeenCodexAssistantMessage(
    state: CodexAssistantDeduperState,
    message: CodexAssistantSessionMessage,
): boolean {
    const fingerprint = buildAssistantFingerprint(message);
    return fingerprint ? state.seenFingerprints.has(fingerprint) : false;
}

export function rememberCodexAssistantMessage(
    state: CodexAssistantDeduperState,
    message: CodexAssistantSessionMessage,
): void {
    const fingerprint = buildAssistantFingerprint(message);
    if (!fingerprint || state.seenFingerprints.has(fingerprint)) {
        return;
    }

    state.recentFingerprints.push(fingerprint);
    state.seenFingerprints.add(fingerprint);

    while (state.recentFingerprints.length > state.maxRecent) {
        const stale = state.recentFingerprints.shift();
        if (stale) {
            state.seenFingerprints.delete(stale);
        }
    }
}

export function resetCodexAssistantDeduper(state: CodexAssistantDeduperState): void {
    state.recentFingerprints.length = 0;
    state.seenFingerprints.clear();
}

export function createCodexAssistantEventReducerState(maxRecent: number = 64): CodexAssistantEventReducerState {
    return {
        deduper: createCodexAssistantDeduper(maxRecent),
        agentMessageDeltaBuffer: '',
    };
}

export function extractCodexEventIdentity(rawMessage: any): CodexEventIdentity {
    const message = unwrapCodexEvent(rawMessage);
    if (!message || typeof message !== 'object') {
        return {
            rawEventType: null,
        };
    }

    const turnIdCandidate = message.turn_id ?? message.turnId;
    const callIdCandidate = message.call_id ?? message.callId ?? message.toolCallId;
    const subagentCandidate = message.subagent ?? message.parent_call_id ?? message.parentCallId;

    return {
        rawEventType: typeof message.type === 'string' ? message.type : null,
        ...(typeof turnIdCandidate === 'string' && turnIdCandidate.length > 0 ? { turnId: turnIdCandidate } : {}),
        ...(typeof callIdCandidate === 'string' && callIdCandidate.length > 0 ? { callId: callIdCandidate } : {}),
        ...(typeof subagentCandidate === 'string' && subagentCandidate.length > 0 ? { providerSubagentId: subagentCandidate } : {}),
    };
}

function buildAssistantSessionMessage(
    state: CodexAssistantEventReducerState,
    assistantMessage: CodexAssistantSessionMessage,
    preferBufferedText: boolean,
): CodexAssistantSessionMessage {
    const message = assistantMessage.type === 'message' && preferBufferedText
        ? (state.agentMessageDeltaBuffer || assistantMessage.message)
        : assistantMessage.message;

    return {
        ...assistantMessage,
        message,
        id: assistantMessage.id || randomUUID(),
    };
}

export function reduceCodexAssistantEvent(
    state: CodexAssistantEventReducerState,
    rawMessage: any,
): CodexAssistantEventReducerResult {
    const message = unwrapCodexEvent(rawMessage);

    if (!message || typeof message !== 'object') {
        return { emitted: [], skippedReason: 'invalid event payload' };
    }

    if (message.type === 'task_started') {
        resetCodexAssistantDeduper(state.deduper);
        state.agentMessageDeltaBuffer = '';
        return { emitted: [], skippedReason: 'task started resets assistant reducer state' };
    }

    if (message.type === 'agent_message_delta' && typeof message.delta === 'string') {
        state.agentMessageDeltaBuffer += message.delta;
        return { emitted: [] };
    }

    const assistantMessage = convertCodexAssistantEventToSessionMessage(message);
    if (assistantMessage && message.type !== 'agent_message' && message.type !== 'agent_reasoning') {
        const sessionMessage = buildAssistantSessionMessage(
            state,
            assistantMessage,
            assistantMessage.type === 'message',
        );
        if (hasSeenCodexAssistantMessage(state.deduper, sessionMessage)) {
            if (sessionMessage.type === 'message') {
                state.agentMessageDeltaBuffer = '';
            }
            return {
                emitted: [],
                skippedReason: 'assistant event duplicated previously emitted content',
            };
        }

        rememberCodexAssistantMessage(state.deduper, sessionMessage);
        if (sessionMessage.type === 'message') {
            state.agentMessageDeltaBuffer = '';
        }
        return { emitted: [sessionMessage] };
    }

    if (message.type === 'item_completed') {
        return {
            emitted: [],
            skippedReason: 'item_completed had no assistant payload to forward',
        };
    }

    if (message.type === 'agent_message' && typeof message.message === 'string') {
        const sessionMessage = buildAssistantSessionMessage(state, {
            type: 'message',
            message: message.message,
        }, true);

        if (hasSeenCodexAssistantMessage(state.deduper, sessionMessage)) {
            state.agentMessageDeltaBuffer = '';
            return {
                emitted: [],
                skippedReason: 'agent_message duplicated previously emitted content',
            };
        }

        rememberCodexAssistantMessage(state.deduper, sessionMessage);
        state.agentMessageDeltaBuffer = '';
        return { emitted: [sessionMessage] };
    }

    if (message.type === 'task_complete' || message.type === 'turn_aborted') {
        if (!state.agentMessageDeltaBuffer) {
            return { emitted: [] };
        }

        const sessionMessage: CodexAssistantSessionMessage = {
            type: 'message',
            message: state.agentMessageDeltaBuffer,
            id: randomUUID(),
        };

        state.agentMessageDeltaBuffer = '';
        if (hasSeenCodexAssistantMessage(state.deduper, sessionMessage)) {
            return {
                emitted: [],
                skippedReason: 'buffered delta duplicated previously emitted content',
            };
        }

        rememberCodexAssistantMessage(state.deduper, sessionMessage);
        return { emitted: [sessionMessage] };
    }

    return { emitted: [] };
}

export function unwrapCodexEvent(rawMessage: any): any {
    if (
        rawMessage &&
        typeof rawMessage === 'object' &&
        rawMessage.type === 'raw_response_item' &&
        rawMessage.item &&
        typeof rawMessage.item === 'object'
    ) {
        return rawMessage.item;
    }
    if (
        rawMessage &&
        typeof rawMessage === 'object' &&
        (rawMessage.type === 'event_msg' || rawMessage.type === 'response_item') &&
        rawMessage.payload &&
        typeof rawMessage.payload === 'object'
    ) {
        return rawMessage.payload;
    }
    return rawMessage;
}

export function decodeCodexDeltaChunk(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        return '';
    }

    try {
        return Buffer.from(value, 'base64').toString('utf-8');
    } catch {
        return value;
    }
}

export function isMcpFunctionName(name: unknown): name is string {
    return typeof name === 'string' && name.startsWith('mcp__');
}

export function convertCodexFunctionEventToSessionMessage(rawMessage: any):
    | {
        type: 'tool-call';
        name: string;
        callId: string;
        input: unknown;
        id: string;
    }
    | {
        type: 'tool-call-result';
        callId: string;
        output: unknown;
        id: string;
    }
    | null {
    const message = unwrapCodexEvent(rawMessage);

    if (!message || typeof message !== 'object') {
        return null;
    }

    if (message.type === 'function_call' && typeof message.name === 'string' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call',
            name: message.name,
            callId: message.call_id,
            input: parseStructuredCodexValue(message.arguments),
            id: randomUUID()
        };
    }

    if (message.type === 'function_call_output' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call-result',
            callId: message.call_id,
            output: parseStructuredCodexValue(message.output),
            id: randomUUID()
        };
    }

    if (message.type === 'custom_tool_call' && typeof message.name === 'string' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call',
            name: message.name,
            callId: message.call_id,
            input: parseStructuredCodexValue(message.input),
            id: randomUUID()
        };
    }

    if (message.type === 'custom_tool_call_output' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call-result',
            callId: message.call_id,
            output: parseStructuredCodexValue(message.output),
            id: randomUUID()
        };
    }

    return null;
}

export function convertCodexMcpLifecycleEventToSessionMessage(rawMessage: any):
    | {
        type: 'tool-call';
        name: string;
        callId: string;
        input: unknown;
        id: string;
    }
    | {
        type: 'tool-call-result';
        callId: string;
        output: unknown;
        id: string;
    }
    | null {
    const message = unwrapCodexEvent(rawMessage);

    if (!message || typeof message !== 'object') {
        return null;
    }

    if (message.type === 'mcp_tool_call_begin' && typeof message.call_id === 'string') {
        return {
            type: 'tool-call',
            name: message.invocation?.tool || 'unknown',
            callId: message.call_id,
            input: message.invocation?.arguments,
            id: randomUUID(),
        };
    }

    if (message.type === 'mcp_tool_call_end' && typeof message.call_id === 'string') {
        const ok = message.result?.Ok;
        const err = message.result?.Err;
        const output = ok ?? err ?? message.result;

        return {
            type: 'tool-call-result',
            callId: message.call_id,
            output,
            id: randomUUID(),
        };
    }

    return null;
}

export function convertCodexApprovalEventToSessionMessage(rawMessage: any):
    | {
        type: 'tool-call';
        name: string;
        callId: string;
        input: unknown;
        id: string;
    }
    | null {
    const message = unwrapCodexEvent(rawMessage);
    if (!message || typeof message !== 'object' || message.type !== 'elicitation_request') {
        return null;
    }

    const approvalRequest = parseCodexApprovalRequest(message);
    if (!approvalRequest) {
        return null;
    }

    return {
        type: 'tool-call',
        name: 'CodexApprovalRequest',
        callId: `approval:${approvalRequest.toolCallId}`,
        input: {
            toolCallId: approvalRequest.toolCallId,
            toolName: approvalRequest.toolName,
            approvalKind: approvalRequest.approvalKind,
            ...approvalRequest.input
        },
        id: randomUUID(),
    };
}

export function convertCodexAssistantEventToSessionMessage(rawMessage: any): CodexAssistantSessionMessage | null {
    const message = unwrapCodexEvent(rawMessage);

    if (!message || typeof message !== 'object') {
        return null;
    }

    if (message.type === 'item_completed' && message.item?.type === 'AgentMessage' && Array.isArray(message.item.content)) {
        const text = message.item.content
            .filter((item: any) => (item?.type === 'Text' || item?.type === 'output_text') && typeof item.text === 'string')
            .map((item: any) => item.text)
            .join('');

        if (!text.trim()) {
            return null;
        }

        return {
            type: 'message',
            message: text,
            id: randomUUID(),
        };
    }

    if (message.type === 'item_completed' && message.item?.type === 'Reasoning') {
        const summary = Array.isArray(message.item.summary_text)
            ? message.item.summary_text
                .map((item: any) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item.text === 'string') return item.text;
                    if (item && typeof item.summary === 'string') return item.summary;
                    return '';
                })
                .filter(Boolean)
                .join('\n')
            : '';

        if (!summary.trim()) {
            return null;
        }

        return {
            type: 'reasoning',
            message: summary,
            id: randomUUID(),
        };
    }

    if (message.type === 'message' && message.role === 'assistant' && Array.isArray(message.content)) {
        const text = message.content
            .filter((item: any) => item?.type === 'output_text' && typeof item.text === 'string')
            .map((item: any) => item.text)
            .join('');

        if (!text.trim()) {
            return null;
        }

        return {
            type: 'message',
            message: text,
            id: randomUUID(),
        };
    }

    if (message.type === 'reasoning') {
        const summary = Array.isArray(message.summary)
            ? message.summary
                .map((item: any) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item.text === 'string') return item.text;
                    if (item && typeof item.summary === 'string') return item.summary;
                    return '';
                })
                .filter(Boolean)
                .join('\n')
            : '';

        if (!summary.trim()) {
            return null;
        }

        return {
            type: 'reasoning',
            message: summary,
            id: randomUUID(),
        };
    }

    return null;
}
