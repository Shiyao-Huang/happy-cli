import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
    class FakeSocket {
        connected = false;
        emitted: Array<{ event: string; args: any[] }> = [];
        handlers = new Map<string, Array<(...args: any[]) => any>>();
        volatile = {
            emit: vi.fn(),
        };
        connect = vi.fn(() => {
            this.connected = true;
            return this;
        });
        close = vi.fn(() => {
            this.connected = false;
        });
        emit = vi.fn((event: string, ...args: any[]) => {
            this.emitted.push({ event, args });
        });
        emitWithAck = vi.fn(async () => ({ result: 'success', metadata: null, version: 1, agentState: null }));
        on = vi.fn((event: string, handler: (...args: any[]) => any) => {
            const existing = this.handlers.get(event) || [];
            existing.push(handler);
            this.handlers.set(event, existing);
            return this;
        });
        off = vi.fn((event: string, handler: (...args: any[]) => any) => {
            const existing = this.handlers.get(event) || [];
            this.handlers.set(event, existing.filter((candidate) => candidate !== handler));
            return this;
        });
        async trigger(event: string, ...args: any[]) {
            const handlers = this.handlers.get(event) || [];
            for (const handler of handlers) {
                await handler(...args);
            }
        }
    }

    const state: {
        socket: FakeSocket | null;
        options: any;
    } = {
        socket: null,
        options: null,
    };

    const ioMock = vi.fn((_origin: string, options: any) => {
        state.options = options;
        state.socket = new FakeSocket();
        return state.socket as any;
    });

    const registerCommonHandlers = vi.fn((manager: { registerHandler: (method: string, handler: () => Promise<any>) => void }) => {
        manager.registerHandler('permission', async () => ({ ok: true }));
    });

    const decryptMock = vi.fn();
    const decodeBase64Mock = vi.fn((value: unknown) => value);
    const encodeBase64Mock = vi.fn((value: unknown) => value);
    const encryptMock = vi.fn((_key: Uint8Array, _variant: string, value: unknown) => value);

    return {
        state,
        ioMock,
        registerCommonHandlers,
        decryptMock,
        decodeBase64Mock,
        encodeBase64Mock,
        encryptMock,
        logger: {
            debug: vi.fn(),
            debugLargeJson: vi.fn(),
        },
    };
});

vi.mock('socket.io-client', () => ({
    io: mocked.ioMock,
}));

vi.mock('@/ui/logger', () => ({
    logger: mocked.logger,
}));

vi.mock('./encryption', () => ({
    decodeBase64: mocked.decodeBase64Mock,
    decrypt: mocked.decryptMock,
    encodeBase64: mocked.encodeBase64Mock,
    encrypt: mocked.encryptMock,
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://localhost:3005',
    },
}));

vi.mock('../modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: mocked.registerCommonHandlers,
}));

vi.mock('./socketPath', () => ({
    buildSocketPath: vi.fn(() => '/v1/updates'),
}));

vi.mock('@/utils/tokenPricing', () => ({
    calculateCost: vi.fn(() => ({
        total: 0,
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
    })),
}));

import { ApiSessionClient } from './apiSession';
import type { Session, UserMessage } from './types';

function buildSession(): Session {
    return {
        id: 'session-1',
        seq: 1,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
    };
}

describe('ApiSessionClient reconnect behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocked.state.socket = null;
        mocked.state.options = null;
    });

    it('creates a socket with infinite reconnect attempts and websocket transport', () => {
        new ApiSessionClient('token-123', buildSession());

        expect(mocked.ioMock).toHaveBeenCalledWith(
            'http://localhost:3005',
            expect.objectContaining({
                auth: expect.objectContaining({
                    token: 'token-123',
                    clientType: 'session-scoped',
                    sessionId: 'session-1',
                }),
                path: '/v1/updates',
                reconnection: true,
                reconnectionAttempts: Infinity,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                transports: ['websocket'],
                autoConnect: false,
            }),
        );
        expect(mocked.state.socket?.connect).toHaveBeenCalledTimes(1);
    });

    it('re-registers RPC handlers after disconnect and reconnect', async () => {
        const client = new ApiSessionClient('token-123', buildSession());
        const socket = mocked.state.socket!;

        await socket.trigger('connect');

        expect(socket.emit).toHaveBeenCalledWith('rpc-register', {
            method: 'session-1:permission',
        });

        socket.emit.mockClear();
        await socket.trigger('disconnect', 'transport close');
        socket.connected = true;
        await socket.trigger('connect');

        expect(socket.emit).toHaveBeenCalledWith('rpc-register', {
            method: 'session-1:permission',
        });
        expect(client.rpcHandlerManager.getHandlerCount()).toBeGreaterThan(0);
    });

    it('calls rpc disconnect cleanup on disconnect and connect_error', async () => {
        const client = new ApiSessionClient('token-123', buildSession());
        const socket = mocked.state.socket!;
        const disconnectSpy = vi.spyOn(client.rpcHandlerManager, 'onSocketDisconnect');

        await socket.trigger('disconnect', 'transport close');
        await socket.trigger('connect_error', new Error('network down'));

        expect(disconnectSpy).toHaveBeenCalledTimes(2);
    });

    it('buffers pending user messages until a callback is attached after reconnect', async () => {
        const client = new ApiSessionClient('token-123', buildSession());
        const socket = mocked.state.socket!;
        const pendingUserMessage: UserMessage = {
            role: 'user',
            content: {
                type: 'text',
                text: 'hello after reconnect',
            },
        };
        mocked.decryptMock.mockReturnValue(pendingUserMessage);

        await socket.trigger('update', {
            body: {
                t: 'new-message',
                message: {
                    id: 'message-1',
                    seq: 1,
                    content: {
                        t: 'encrypted',
                        c: 'encrypted-payload',
                    },
                },
            },
        });

        const received: UserMessage[] = [];
        client.onUserMessage((message) => {
            received.push(message);
        });

        expect(received).toEqual([pendingUserMessage]);
    });
});
