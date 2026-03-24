import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from './RpcHandlerManager';

describe('RpcHandlerManager', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('retries rpc registration until the server acknowledges the method', () => {
        const socket = {
            connected: true,
            emit: vi.fn(),
            on: vi.fn(),
            off: vi.fn()
        };

        let onRegistered: ((data: { method?: string }) => void) | undefined;
        socket.on.mockImplementation((event: string, handler: (data: { method?: string }) => void) => {
            if (event === 'rpc-registered') {
                onRegistered = handler;
            }
        });

        const manager = new RpcHandlerManager({
            scopePrefix: 'machine-1',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy'
        });

        manager.registerHandler('spawn-aha-session', async () => ({ ok: true }));
        manager.onSocketConnect(socket as any);

        expect(socket.emit).toHaveBeenCalledTimes(1);
        expect(socket.emit).toHaveBeenCalledWith('rpc-register', {
            method: 'machine-1:spawn-aha-session'
        });

        vi.advanceTimersByTime(250);
        expect(socket.emit).toHaveBeenCalledTimes(2);

        onRegistered?.({ method: 'machine-1:spawn-aha-session' });
        vi.advanceTimersByTime(5000);

        expect(socket.emit).toHaveBeenCalledTimes(2);
        expect(socket.off).not.toHaveBeenCalled();
    });

    it('clears retry timers and listeners on disconnect', () => {
        const socket = {
            connected: true,
            emit: vi.fn(),
            on: vi.fn(),
            off: vi.fn()
        };

        const manager = new RpcHandlerManager({
            scopePrefix: 'session-1',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy'
        });

        manager.registerHandler('permission', async () => ({ ok: true }));
        manager.onSocketConnect(socket as any);
        manager.onSocketDisconnect();

        vi.advanceTimersByTime(5000);

        expect(socket.emit).toHaveBeenCalledTimes(1);
        expect(socket.off).toHaveBeenCalledWith('rpc-registered', expect.any(Function));
    });
});
