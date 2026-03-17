import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration } from "@/configuration";
import { randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { displayQRCode } from "./qrcode";
import { delay } from "@/utils/time";
import { writeCredentialsLegacy, readCredentials, updateSettings, Credentials, writeCredentialsDataKey, writeCredentialsContentSecretKey } from "@/persistence";
import { generateWebAuthUrl } from "@/api/webAuth";
import { openBrowser } from "@/utils/browser";
import { randomUUID } from 'node:crypto';
import { logger } from './logger';

export type AuthMethod = 'mobile' | 'web';
export type WebAuthMode = 'auto' | 'create' | 'reconnect';

interface DoAuthOptions {
    method?: AuthMethod;
    webNextPath?: string;
    machineId?: string;
    webMode?: WebAuthMode;
}

interface AuthSetupOptions extends DoAuthOptions {
}

export async function doAuth(options: DoAuthOptions = {}): Promise<Credentials | null> {
    console.clear();
    const authMethod = options.method ?? 'web';

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);

    // Create a new authentication request
    try {
        console.log(`[AUTH DEBUG] Sending auth request to: ${configuration.serverUrl}/v1/auth/request`);
        console.log(`[AUTH DEBUG] Public key: ${encodeBase64(keypair.publicKey).substring(0, 20)}...`);
        await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(keypair.publicKey),
            supportsV2: true
        });
        console.log(`[AUTH DEBUG] Auth request sent successfully`);
    } catch (error) {
        console.log(`[AUTH DEBUG] Failed to send auth request:`, error);
        console.log('Failed to create authentication request, please try again later.');
        return null;
    }

    // Handle authentication based on selected method
    if (authMethod === 'mobile') {
        return await doMobileAuth(keypair);
    } else {
        return await doWebAuth(keypair, options);
    }
}

/**
 * Handle mobile authentication flow
 */
async function doMobileAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    console.clear();
    console.log('\nMobile Authentication\n');
    console.log('Scan this QR code with your Aha mobile app:\n');

    const authUrl = 'aha://terminal?' + encodeBase64Url(keypair.publicKey);
    displayQRCode(authUrl);

    console.log('\nOr manually enter this URL:');
    console.log(authUrl);
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Handle web authentication flow
 */
async function doWebAuth(keypair: tweetnacl.BoxKeyPair, options: DoAuthOptions): Promise<Credentials | null> {
    console.clear();
    console.log('\nWeb Authentication\n');

    const webUrl = generateWebAuthUrl(keypair.publicKey, {
        nextPath: options.webNextPath,
        machineId: options.machineId,
        mode: options.webMode
    });
    console.log('Opening your browser...');

    const browserOpened = await openBrowser(webUrl);

    if (browserOpened) {
        console.log('✓ Browser opened\n');
        console.log('Complete authentication in your browser window.');
    } else {
        console.log('Could not open browser automatically.');
    }

    // I changed this to always show the URL because we got a report from
    // someone running aha inside a devcontainer that they saw the
    // "Complete authentication in your browser window." but nothing opened.
    // https://github.com/slopus/aha/issues/19
    console.log('\nIf the browser did not open, please copy and paste this URL:');
    console.log(webUrl);
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Wait for authentication to complete and return credentials
 */
async function waitForAuthentication(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    process.stdout.write('Waiting for authentication');
    let dots = 0;
    let cancelled = false;

    // Handle Ctrl-C during waiting
    const handleInterrupt = () => {
        cancelled = true;
        console.log('\n\nAuthentication cancelled.');
        process.exit(0);
    };

    process.on('SIGINT', handleInterrupt);

    try {
        while (!cancelled) {
            try {
                const response = await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
                    publicKey: encodeBase64(keypair.publicKey),
                    supportsV2: true
                });
                if (response.data.state === 'authorized') {
                    let token = response.data.token as string;
                    let r = decodeBase64(response.data.response);
                    let decrypted = decryptWithEphemeralKey(r, keypair.secretKey);
                    if (decrypted) {
                        if (decrypted.length === 32) {
                            const credentials = {
                                secret: decrypted,
                                token: token
                            }
                            await writeCredentialsLegacy(credentials);
                            console.log('\n\n✓ Authentication successful\n');
                            return {
                                encryption: {
                                    type: 'legacy',
                                    secret: decrypted
                                },
                                token: token
                            };
                        } else {
                            if (decrypted[0] === 0) {
                                // V2 response: contentSecretKey from Kanban
                                const contentSecretKey = decrypted.slice(1, 33);
                                const credentials = {
                                    contentSecretKey: contentSecretKey,
                                    token: token
                                }
                                await writeCredentialsContentSecretKey(credentials);
                                console.log('\n\n✓ Authentication successful (V2 with contentSecretKey)\n');
                                return {
                                    encryption: {
                                        type: 'contentSecretKey',
                                        contentSecretKey: contentSecretKey
                                    },
                                    token: token
                                };
                            } else {
                                console.log('\n\nFailed to decrypt response. Please try again.');
                                return null;
                            }
                        }
                    } else {
                        console.log('\n\nFailed to decrypt response. Please try again.');
                        return null;
                    }
                }
            } catch (error) {
                console.log('\n\nFailed to check authentication status. Please try again.');
                return null;
            }

            // Animate waiting dots
            process.stdout.write('\rWaiting for authentication' + '.'.repeat((dots % 3) + 1) + '   ');
            dots++;

            await delay(1000);
        }
    } finally {
        process.off('SIGINT', handleInterrupt);
    }

    return null;
}

export function decryptWithEphemeralKey(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    // Extract components from bundle: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
    const ephemeralPublicKey = encryptedBundle.slice(0, 32);
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength);

    const decrypted = tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    if (!decrypted) {
        return null;
    }

    return decrypted;
}


/**
 * Ensure authentication and machine setup
 * This replaces the onboarding flow and ensures everything is ready
 */
export async function authAndSetupMachineIfNeeded(options: AuthSetupOptions = {}): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    const settings = await updateSettings(async s => {
        if (s.machineId) {
            return s;
        }
        return {
            ...s,
            machineId: randomUUID()
        };
    });

    const machineId = settings.machineId!;

    // Step 1: Handle authentication
    let credentials = await readCredentials();

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth({
            method: options.method,
            webNextPath: options.webNextPath,
            machineId
        });
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }

    logger.debug(`[AUTH] Machine ID: ${machineId}`);

    return { credentials, machineId };
}
