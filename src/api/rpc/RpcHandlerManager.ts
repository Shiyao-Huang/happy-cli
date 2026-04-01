/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
} from './types';
import { Socket } from 'socket.io-client';

const RPC_ERROR_FLAG = '__ahaRpcError';

type RpcErrorPayload = {
    __ahaRpcError: true;
    message: string;
};

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly logger: (message: string, data?: any) => void;
    private socket: Socket | null = null;
    private readonly pendingAckMethods = new Set<string>();
    private readonly registrationRetryTimers = new Set<NodeJS.Timeout>();
    private rpcRegisteredListener: ((data: { method?: string }) => void) | null = null;

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);

        if (this.socket?.connected) {
            this.registerMethodWithRetry(prefixedMethod);
        }
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        try {
            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                return this.encryptResponse(this.createRpcErrorPayload('Method not found'));
            }

            // Decrypt the incoming params
            const decryptedParams = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(request.params));

            // Call the handler
            const result = await handler(decryptedParams);

            // Encrypt and return the response
            return this.encryptResponse(result);
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request', { error });
            return this.encryptResponse(
                this.createRpcErrorPayload(error instanceof Error ? error.message : 'Unknown error')
            );
        }
    }

    onSocketConnect(socket: Socket): void {
        this.detachRpcRegisteredListener();
        this.clearRegistrationRetryTimers();
        this.socket = socket;

        this.rpcRegisteredListener = (data: { method?: string }) => {
            if (!data?.method) {
                return;
            }

            this.pendingAckMethods.delete(data.method);
            if (this.pendingAckMethods.size === 0) {
                this.clearRegistrationRetryTimers();
            }
        };

        socket.on('rpc-registered', this.rpcRegisteredListener);

        for (const [prefixedMethod] of this.handlers) {
            this.registerMethodWithRetry(prefixedMethod);
        }
    }

    onSocketDisconnect(): void {
        this.detachRpcRegisteredListener();
        this.clearRegistrationRetryTimers();
        this.pendingAckMethods.clear();
        this.socket = null;
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.logger('Cleared all RPC handlers');
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }

    private createRpcErrorPayload(message: string): RpcErrorPayload {
        return {
            [RPC_ERROR_FLAG]: true,
            message,
        };
    }

    private encryptResponse(data: any): string {
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, data));
    }

    private registerMethodWithRetry(method: string): void {
        if (!this.socket?.connected) {
            return;
        }

        if (this.pendingAckMethods.has(method)) {
            return;
        }

        this.pendingAckMethods.add(method);
        this.socket.emit('rpc-register', { method });

        for (const delayMs of [250, 1000, 2500]) {
            const timer = setTimeout(() => {
                this.registrationRetryTimers.delete(timer);

                if (!this.socket?.connected) {
                    return;
                }

                if (!this.pendingAckMethods.has(method)) {
                    return;
                }

                this.socket.emit('rpc-register', { method });
            }, delayMs);

            this.registrationRetryTimers.add(timer);
        }
    }

    private clearRegistrationRetryTimers(): void {
        for (const timer of this.registrationRetryTimers) {
            clearTimeout(timer);
        }
        this.registrationRetryTimers.clear();
    }

    private detachRpcRegisteredListener(): void {
        if (this.socket && this.rpcRegisteredListener) {
            this.socket.off('rpc-registered', this.rpcRegisteredListener);
        }
        this.rpcRegisteredListener = null;
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
