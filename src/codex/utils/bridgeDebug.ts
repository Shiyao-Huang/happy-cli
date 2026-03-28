import { logger } from '@/ui/logger';

export const CODEX_BRIDGE_DEBUG_ENV = 'AHA_CODEX_BRIDGE_DEBUG';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on', 'debug']);

export function isCodexBridgeDebugEnabled(): boolean {
    const rawValue = process.env[CODEX_BRIDGE_DEBUG_ENV];
    if (!rawValue) {
        return false;
    }

    return ENABLED_VALUES.has(rawValue.trim().toLowerCase());
}

export function logCodexBridge(message: string, payload?: unknown): void {
    if (!isCodexBridgeDebugEnabled()) {
        return;
    }

    if (payload === undefined) {
        logger.debug(`[CodexBridge] ${message}`);
        return;
    }

    logger.debugLargeJson(`[CodexBridge] ${message}`, payload);
}

function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function previewString(value: unknown, maxLength: number = 120): string | null {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }

    return value.length > maxLength
        ? `${value.slice(0, maxLength)}...`
        : value;
}

export function summarizeCodexSignal(signal: unknown): Record<string, unknown> {
    const root = asObject(signal);
    if (!root) {
        return {
            signalType: typeof signal,
            raw: signal
        };
    }

    const item = asObject(root.item);
    const invocation = asObject(root.invocation);
    const request = asObject(root.request);
    const meta = asObject(request?._meta);

    const summary: Record<string, unknown> = {
        signalType: asString(root.type) ?? 'unknown',
    };

    const fields: Array<[string, unknown]> = [
        ['role', root.role],
        ['name', root.name],
        ['id', root.id],
        ['callId', root.call_id ?? root.callId],
        ['threadId', root.thread_id ?? root.threadId],
        ['turnId', root.turn_id ?? root.turnId],
        ['stream', root.stream],
        ['server', root.server_name ?? root.server ?? invocation?.server],
        ['tool', invocation?.tool ?? meta?.tool ?? root.tool],
        ['itemType', item?.type],
        ['approvalKind', meta?.codex_approval_kind ?? root.codex_elicitation],
    ];

    for (const [key, value] of fields) {
        if (value !== undefined && value !== null && value !== '') {
            summary[key] = value;
        }
    }

    const messagePreview =
        previewString(root.message) ??
        previewString(request?.message) ??
        previewString(root.command);
    if (messagePreview) {
        summary.messagePreview = messagePreview;
    }

    const deltaPreview = previewString(root.delta);
    if (deltaPreview) {
        summary.deltaPreview = deltaPreview;
        summary.deltaLength = typeof root.delta === 'string' ? root.delta.length : undefined;
    }

    const chunkPreview = previewString(root.chunk);
    if (chunkPreview) {
        summary.chunkPreview = chunkPreview;
        summary.chunkLength = typeof root.chunk === 'string' ? root.chunk.length : undefined;
    }

    const textPreview =
        previewString(root.text) ??
        previewString(root.output) ??
        previewString(root.error);
    if (textPreview) {
        summary.textPreview = textPreview;
    }

    return summary;
}

export function logCodexSignal(stage: string, signal: unknown, extra?: unknown): void {
    if (!isCodexBridgeDebugEnabled()) {
        return;
    }

    const payload = {
        summary: summarizeCodexSignal(signal),
        ...(extra === undefined ? {} : { extra })
    };

    logger.debugLargeJson(`[CodexBridge][Signal] ${stage}`, payload);
}
