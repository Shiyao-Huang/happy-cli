import { encodeBase64 } from './encryption';
import { configuration } from '@/configuration';

interface WebAuthUrlOptions {
    nextPath?: string;
    machineId?: string;
}

/**
 * Generate a URL for web authentication
 * @param publicKey - The ephemeral public key to include in the URL
 * @returns The web authentication URL
 */
export function generateWebAuthUrl(publicKey: Uint8Array, options: WebAuthUrlOptions = {}): string {
    const publicKeyBase64 = encodeBase64(publicKey, 'base64url');
    const url = new URL(`${configuration.webappUrl}/terminal/connect`);
    const hashParams = new URLSearchParams();
    hashParams.set('key', publicKeyBase64);
    hashParams.set('serverUrl', configuration.serverUrl);

    if (options.nextPath) {
        hashParams.set('next', options.nextPath);
    }

    if (options.machineId) {
        hashParams.set('machineId', options.machineId);
    }

    url.hash = hashParams.toString();
    return url.toString();
}
