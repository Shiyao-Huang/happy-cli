import { describe, expect, it, vi } from 'vitest';
import { applyCodexSessionNamingFromEnv, emitReadyIfIdle, getCodexToolError } from '../runCodex';

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
