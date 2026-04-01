import { getDefaultEnvironment, StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import crossSpawn from 'cross-spawn';

type InternalTransport = {
    _process?: ReturnType<typeof crossSpawn>;
    _abortController: AbortController;
    _readBuffer: {
        append(chunk: unknown): void;
        clear(): void;
    };
    _serverParams: StdioServerParameters;
    _stderrStream?: NodeJS.WritableStream | null;
    processReadBuffer(): void;
};

export class WindowsSafeStdioClientTransport extends StdioClientTransport {
    async start(): Promise<void> {
        if (process.platform !== 'win32') {
            return super.start();
        }

        const transport = this as unknown as InternalTransport;
        if (transport._process) {
            throw new Error('StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.');
        }

        return new Promise((resolve, reject) => {
            transport._process = crossSpawn(transport._serverParams.command, transport._serverParams.args ?? [], {
                env: {
                    ...getDefaultEnvironment(),
                    ...transport._serverParams.env,
                },
                stdio: ['pipe', 'pipe', transport._serverParams.stderr ?? 'inherit'],
                shell: false,
                signal: transport._abortController.signal,
                windowsHide: true,
                cwd: transport._serverParams.cwd,
            });

            transport._process.on('error', (error: Error & { name?: string }) => {
                if (error.name === 'AbortError') {
                    this.onclose?.();
                    return;
                }

                reject(error);
                this.onerror?.(error);
            });

            transport._process.on('spawn', () => {
                resolve();
            });

            transport._process.on('close', () => {
                transport._process = undefined;
                this.onclose?.();
            });

            transport._process.stdin?.on('error', (error: Error) => {
                this.onerror?.(error);
            });

            transport._process.stdout?.on('data', (chunk: Buffer) => {
                transport._readBuffer.append(chunk);
                transport.processReadBuffer();
            });

            transport._process.stdout?.on('error', (error: Error) => {
                this.onerror?.(error);
            });

            if (transport._stderrStream && transport._process.stderr) {
                transport._process.stderr.pipe(transport._stderrStream);
            }
        });
    }
}

export function createCodexTransport(server: StdioServerParameters): StdioClientTransport {
    if (process.platform === 'win32') {
        return new WindowsSafeStdioClientTransport(server);
    }

    return new StdioClientTransport(server);
}
