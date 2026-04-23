import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { logger } from '@/ui/logger';

const CHATGPT_HOST = 'chatgpt.com';
const CLOUDFLARE_DOH_URL = 'https://cloudflare-dns.com/dns-query?name=chatgpt.com&type=A';

export type CodexNetworkShim = {
    env: Record<string, string>;
    close: () => Promise<void>;
    proxyUrl: string;
    chatGptIps: string[];
};

type DnsJsonResponse = {
    Answer?: Array<{
        type?: number;
        data?: string;
    }>;
};

function hasExplicitHttpsProxy(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
    return Boolean(env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy);
}

export function isCodexFakeIpAddress(address: string | null | undefined): boolean {
    if (!address) {
        return false;
    }

    const parts = address.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }

    // RFC 2544 benchmarking range. Clash/Vortex-style TUN fake-ip mode often maps domains here.
    return parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

export function shouldEnableCodexNetworkShim(args: {
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    resolvedAddresses: string[];
}): boolean {
    if (args.env.AHA_CODEX_DISABLE_NETWORK_SHIM === '1') {
        return false;
    }
    if (args.env.AHA_CODEX_FORCE_NETWORK_SHIM === '1') {
        return true;
    }
    if (hasExplicitHttpsProxy(args.env)) {
        return false;
    }
    return args.resolvedAddresses.some(isCodexFakeIpAddress);
}

function isUsablePublicIpv4(address: string | null | undefined): address is string {
    if (!address || isCodexFakeIpAddress(address)) {
        return false;
    }

    const parts = address.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }

    const [a, b] = parts;
    return !(
        a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || a >= 224
    );
}

async function fetchDnsJson(url: string): Promise<DnsJsonResponse> {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: { accept: 'application/dns-json' },
            timeout: 5000,
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body) as DnsJsonResponse);
                } catch (error) {
                    reject(error);
                }
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error('DNS-over-HTTPS request timed out'));
        });
        request.on('error', reject);
    });
}

async function resolveLocalChatGptAddresses(): Promise<string[]> {
    try {
        const records = await dns.lookup(CHATGPT_HOST, { all: true, family: 4 });
        return records.map((record) => record.address);
    } catch (error) {
        logger.debug('[CodexNetwork] Failed to resolve local chatgpt.com addresses:', error);
        return [];
    }
}

async function resolvePublicChatGptAddresses(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Promise<string[]> {
    const configured = env.AHA_CODEX_CHATGPT_IPS
        ?.split(',')
        .map((part) => part.trim())
        .filter(isUsablePublicIpv4);
    if (configured?.length) {
        return configured;
    }

    const response = await fetchDnsJson(CLOUDFLARE_DOH_URL);
    const ips = response.Answer
        ?.filter((answer) => answer.type === 1)
        .map((answer) => answer.data)
        .filter(isUsablePublicIpv4) ?? [];

    return Array.from(new Set(ips));
}

function startConnectProxy(chatGptIps: string[]): Promise<{ proxyUrl: string; close: () => Promise<void> }> {
    let nextIpIndex = 0;
    const server = http.createServer((_, response) => {
        response.writeHead(405);
        response.end('CONNECT only');
    });

    server.on('connect', (request, clientSocket, head) => {
        const [host, rawPort] = (request.url || '').split(':');
        const port = Number(rawPort || 443);
        const targetHost = host === CHATGPT_HOST
            ? chatGptIps[nextIpIndex++ % chatGptIps.length]
            : host;

        if (!targetHost || !Number.isInteger(port) || port <= 0) {
            clientSocket.destroy();
            return;
        }

        const upstream = net.connect(port, targetHost, () => {
            clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
            if (head.length) {
                upstream.write(head);
            }
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });

        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Unable to allocate Codex network shim port'));
                return;
            }

            const proxyUrl = `http://127.0.0.1:${address.port}`;
            resolve({
                proxyUrl,
                close: () => new Promise((closeResolve) => {
                    server.close(() => closeResolve());
                }),
            });
        });
    });
}

export async function prepareCodexNetworkShim(
    env: NodeJS.ProcessEnv = process.env,
): Promise<CodexNetworkShim | null> {
    const localAddresses = await resolveLocalChatGptAddresses();
    if (!shouldEnableCodexNetworkShim({ env, resolvedAddresses: localAddresses })) {
        return null;
    }

    try {
        const chatGptIps = await resolvePublicChatGptAddresses(env);
        if (!chatGptIps.length) {
            logger.debug('[CodexNetwork] Fake-ip DNS detected, but no public chatgpt.com IPs were available.');
            return null;
        }

        const proxy = await startConnectProxy(chatGptIps);
        logger.debug(`[CodexNetwork] Enabled local CONNECT shim for ${CHATGPT_HOST}: ${proxy.proxyUrl} -> ${chatGptIps.join(', ')}`);

        return {
            env: {
                HTTPS_PROXY: proxy.proxyUrl,
                HTTP_PROXY: proxy.proxyUrl,
            },
            close: proxy.close,
            proxyUrl: proxy.proxyUrl,
            chatGptIps,
        };
    } catch (error) {
        logger.debug('[CodexNetwork] Failed to enable local CONNECT shim:', error);
        return null;
    }
}
