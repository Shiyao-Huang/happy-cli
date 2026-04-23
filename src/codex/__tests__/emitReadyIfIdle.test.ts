import { describe, expect, it, vi } from 'vitest';
import {
    applyCodexSessionNamingFromEnv,
    emitReadyIfIdle,
    extractHttpStatusCodeFromError,
    getCodexToolError,
    isInvalidFromSessionIdHandshakeError,
    isRetryableHandshakeError,
    resolveCodexModelOverride,
    resolveTeamActorSessionId,
    sendTeamHandshakeWithRetry,
} from '../runCodex';

describe('emitReadyIfIdle', () => {
    it('emits ready and notification when queue is idle', () => {
        const sendReady = vi.fn();
        const notify = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
            notify,
        });

        expect(emitted).toBe(true);
        expect(sendReady).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('skips when a message is still pending', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: {},
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it('skips when queue still has items', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 2,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it('skips when shutdown is requested', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 0,
            shouldExit: true,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it('skips when the runtime is unhealthy', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 0,
            shouldExit: false,
            healthy: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });
});

describe('getCodexToolError', () => {
    it('returns null for successful responses', () => {
        expect(getCodexToolError({
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
        })).toBeNull();
    });

    it('returns the text payload for error responses', () => {
        expect(getCodexToolError({
            content: [{ type: 'text', text: 'Token data is not available.' }],
            isError: true,
        })).toBe('Token data is not available.');
    });

    it('falls back to a generic message when the error payload is empty', () => {
        expect(getCodexToolError({
            content: [{ type: 'text', text: '   ' }],
            isError: true,
        })).toBe('Codex MCP tool call returned an error.');
    });
});

describe('applyCodexSessionNamingFromEnv', () => {
    it('prefers explicit session name over room name', () => {
        const metadata = {} as { name?: string; roomName?: string };

        applyCodexSessionNamingFromEnv(metadata as any, {
            AHA_SESSION_NAME: 'Codex Implementer',
            AHA_ROOM_NAME: 'Delivery Team',
        });

        expect(metadata).toEqual({
            name: 'Codex Implementer',
            roomName: 'Delivery Team',
        });
    });

    it('falls back to room name when session name is absent', () => {
        const metadata = {} as { name?: string; roomName?: string };

        applyCodexSessionNamingFromEnv(metadata as any, {
            AHA_ROOM_NAME: 'Delivery Team',
        });

        expect(metadata).toEqual({
            name: 'Delivery Team',
            roomName: 'Delivery Team',
        });
    });
});

describe('resolveCodexModelOverride', () => {
    it('keeps Codex-compatible model IDs', () => {
        expect(resolveCodexModelOverride('gpt-5.4')).toBe('gpt-5.4');
        expect(resolveCodexModelOverride('  gpt-5.4  ')).toBe('gpt-5.4');
    });

    it('drops Anthropic model IDs so Codex uses its configured default', () => {
        expect(resolveCodexModelOverride('claude-sonnet-4-6')).toBeUndefined();
        expect(resolveCodexModelOverride('anthropic/claude-sonnet-4-6')).toBeUndefined();
        expect(resolveCodexModelOverride('anthropic:claude-opus-4-6')).toBeUndefined();
    });

    it('treats empty values as no override', () => {
        expect(resolveCodexModelOverride('')).toBeUndefined();
        expect(resolveCodexModelOverride('   ')).toBeUndefined();
        expect(resolveCodexModelOverride(undefined)).toBeUndefined();
    });
});

describe('resolveTeamActorSessionId', () => {
    it('uses metadata.ahaSessionId when present', () => {
        expect(resolveTeamActorSessionId({ ahaSessionId: 'session-aha' }, 'session-local')).toBe('session-aha');
    });

    it('falls back to local session id when ahaSessionId is empty', () => {
        expect(resolveTeamActorSessionId({ ahaSessionId: '   ' }, 'session-local')).toBe('session-local');
    });
});

describe('extractHttpStatusCodeFromError', () => {
    it('reads top-level status field', () => {
        expect(extractHttpStatusCodeFromError({ status: 503 })).toBe(503);
    });

    it('reads nested response.status field', () => {
        expect(extractHttpStatusCodeFromError({ response: { status: 429 } })).toBe(429);
    });

    it('parses status code from error message', () => {
        expect(extractHttpStatusCodeFromError(new Error('Request failed with status code 403'))).toBe(403);
    });

    it('returns undefined when no status is available', () => {
        expect(extractHttpStatusCodeFromError(new Error('socket hang up'))).toBeUndefined();
    });
});

describe('handshake error classifiers', () => {
    it('treats configured status codes as retryable', () => {
        expect(isRetryableHandshakeError(new Error('Request failed with status code 503'))).toBe(true);
        expect(isRetryableHandshakeError(new Error('Request failed with status code 403'))).toBe(true);
    });

    it('treats network-like errors as retryable', () => {
        expect(isRetryableHandshakeError(new Error('socket disconnected'))).toBe(true);
        expect(isRetryableHandshakeError(new Error('ECONNRESET'))).toBe(true);
    });

    it('does not retry non-retryable status codes', () => {
        expect(isRetryableHandshakeError(new Error('Request failed with status code 401'))).toBe(false);
    });

    it('matches invalid fromSessionId errors', () => {
        expect(isInvalidFromSessionIdHandshakeError(new Error('Invalid fromSessionId: abc'))).toBe(true);
        expect(isInvalidFromSessionIdHandshakeError(new Error('request failed with status code 503'))).toBe(false);
    });
});

describe('sendTeamHandshakeWithRetry', () => {
    it('succeeds on first attempt', async () => {
        const sendTeamMessage = vi.fn().mockResolvedValue(undefined);
        const api = { sendTeamMessage } as any;

        await sendTeamHandshakeWithRetry({
            api,
            teamId: 'team-1',
            message: { id: 'msg-1' },
            sleep: async () => undefined,
        });

        expect(sendTeamMessage).toHaveBeenCalledTimes(1);
        expect(sendTeamMessage).toHaveBeenCalledWith('team-1', { id: 'msg-1' });
    });

    it('retries retryable errors and eventually succeeds', async () => {
        const sendTeamMessage = vi
            .fn()
            .mockRejectedValueOnce(new Error('Request failed with status code 503'))
            .mockResolvedValueOnce(undefined);
        const api = { sendTeamMessage } as any;
        const sleep = vi.fn().mockResolvedValue(undefined);

        await sendTeamHandshakeWithRetry({
            api,
            teamId: 'team-2',
            message: { id: 'msg-2' },
            maxAttempts: 2,
            sleep,
        });

        expect(sendTeamMessage).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(250);
    });

    it('fails fast on non-retryable errors', async () => {
        const sendTeamMessage = vi.fn().mockRejectedValue(new Error('Request failed with status code 401'));
        const api = { sendTeamMessage } as any;
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(sendTeamHandshakeWithRetry({
            api,
            teamId: 'team-3',
            message: { id: 'msg-3' },
            maxAttempts: 3,
            sleep,
        })).rejects.toThrow('status code 401');

        expect(sendTeamMessage).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('throws after max attempts for retryable errors', async () => {
        const sendTeamMessage = vi
            .fn()
            .mockRejectedValue(new Error('Request failed with status code 502'));
        const api = { sendTeamMessage } as any;
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(sendTeamHandshakeWithRetry({
            api,
            teamId: 'team-4',
            message: { id: 'msg-4' },
            maxAttempts: 3,
            sleep,
        })).rejects.toThrow('status code 502');

        expect(sendTeamMessage).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenNthCalledWith(1, 250);
        expect(sleep).toHaveBeenNthCalledWith(2, 500);
    });
});
