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
import { AuthSelector, AuthMethod } from "./ink/AuthSelector";
import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import chalk from 'chalk';

export async function doAuth(headless: boolean = false): Promise<Credentials | null> {
    console.clear();

    // R2: Device code auth is now the primary method (one-click)
    // Try device code auth first, fall back to selector if user cancels
    const deviceCodeResult = await doDeviceCodeAuth(headless);
    if (deviceCodeResult) {
        return deviceCodeResult;
    }

    // Fallback: Show authentication method selector
    const authMethod = await selectAuthenticationMethod();
    if (!authMethod) {
        console.log('\nAuthentication cancelled.\n');
        process.exit(0);
    }

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
        return await doWebAuth(keypair);
    }
}

/**
 * Display authentication method selector and return user choice
 */
function selectAuthenticationMethod(): Promise<AuthMethod | null> {
    return new Promise((resolve) => {
        let hasResolved = false;

        const onSelect = (method: AuthMethod) => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(method);
            }
        };

        const onCancel = () => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(null);
            }
        };

        const app = render(React.createElement(AuthSelector, { onSelect, onCancel }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    });
}

/**
 * Handle mobile authentication flow
 */
async function doMobileAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    console.clear();
    console.log('\nMobile Authentication\n');
    console.log('Scan this QR code with your Happy mobile app:\n');

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
async function doWebAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    console.clear();
    console.log('\nWeb Authentication\n');

    const webUrl = generateWebAuthUrl(keypair.publicKey);
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
 * Handle device code authentication flow (R2: One-Click Auth)
 * This is the primary auth method for CLI - displays a 6-char code and auto-opens browser
 * @param headless - If true, skip browser opening (for SSH/CI environments)
 */
export async function doDeviceCodeAuth(headless: boolean = false): Promise<Credentials | null> {
    console.clear();
    console.log(chalk.bold('\n🔑 Device Code Authentication\n'));

    if (headless) {
        console.log(chalk.yellow('Headless mode: Browser will not open automatically\n'));
    }

    // Generate ephemeral keypair for this device
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
    const publicKeyBase64 = encodeBase64(keypair.publicKey);

    try {
        // Request a device code from the server
        const response = await axios.post(`${configuration.serverUrl}/v1/auth/device-code`, {
            publicKey: publicKeyBase64
        });

        const { userCode, deviceCode, expiresIn, verificationUri } = response.data;

        // Display the device code prominently
        console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.bold.white(`  Your device code: `) + chalk.cyan.bold(userCode));
        console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log('');
        console.log(chalk.gray(`  Expires in ${Math.floor(expiresIn / 60)} minutes`));
        console.log('');

        // Display QR code for easy mobile scanning
        console.log(chalk.gray('Scan this QR code or visit:'));
        console.log('');
        displayQRCode(verificationUri);
        console.log('');
        console.log(chalk.gray(verificationUri));
        console.log('');

        // Auto-open browser with verification URL (skip in headless mode)
        if (!headless) {
            console.log('Opening browser for verification...');
            const browserOpened = await openBrowser(verificationUri);

            if (browserOpened) {
                console.log(chalk.green('✓ Browser opened'));
            } else {
                console.log(chalk.yellow('⚠ Could not open browser automatically'));
                console.log(chalk.gray('Please visit the URL above to verify'));
            }
        } else {
            console.log(chalk.cyan('Visit the URL above to verify your device'));
        }

        // Poll for approval with cancel support
        console.log('');
        console.log(chalk.gray('Waiting for verification (press Ctrl+C to cancel)'));
        process.stdout.write(chalk.gray('.'));

        const startTime = Date.now();
        const timeoutMs = expiresIn * 1000;
        let cancelled = false;

        const handleCancel = async () => {
            cancelled = true;
            console.log(chalk.yellow('\n\nCancelling authentication...'));
            try {
                await axios.delete(`${configuration.serverUrl}/v1/auth/device-code/cancel`, {
                    data: { deviceCode }
                });
            } catch {
                // Best effort cancel
            }
            console.log(chalk.yellow('Authentication cancelled.\n'));
        };

        process.on('SIGINT', handleCancel);

        try {
            while (!cancelled && Date.now() - startTime < timeoutMs) {
                await delay(2000);

                if (cancelled) break;

                // Show remaining time every 30 seconds
                const elapsed = Date.now() - startTime;
                const remaining = Math.ceil((timeoutMs - elapsed) / 1000);
                if (remaining % 30 === 0 && remaining > 0) {
                    process.stdout.write(chalk.gray(` ${Math.floor(remaining / 60)}m${remaining % 60}s `));
                }

                try {
                    const pollResponse = await axios.get(
                        `${configuration.serverUrl}/v1/auth/device-code/poll?device_code=${deviceCode}`
                    );

                    if (pollResponse.data.status === 'approved') {
                        const token = pollResponse.data.token;
                        console.log(chalk.green('\n\n✓ Authentication successful!\n'));

                        // Store credentials
                        const credentials: Credentials = {
                            encryption: {
                                type: 'legacy',
                                secret: secret
                            },
                            token: token
                        };
                        await writeCredentialsLegacy(credentials);
                        return credentials;
                    }

                    if (pollResponse.data.status === 'expired') {
                        console.log(chalk.red('\n\n✗ Device code expired. Please try again.\n'));
                        return null;
                    }

                    // Still pending - show progress
                    process.stdout.write(chalk.gray('.'));

                } catch (pollError) {
                    // Log but continue polling on transient errors
                    logger.debug('Poll error:', pollError);
                    process.stdout.write(chalk.yellow('!'));
                }
            }
        } finally {
            process.off('SIGINT', handleCancel);
        }

        if (cancelled) {
            return null;
        }

        console.log(chalk.red('\n\n✗ Authentication timed out. Please try again.\n'));
        return null;

    } catch (error) {
        console.log(chalk.red('\nFailed to start device code authentication.\n'));
        logger.error('Device code auth error:', error);
        return null;
    }
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
 * @param headless - If true, skip browser opening during auth (for SSH/CI environments)
 */
export async function authAndSetupMachineIfNeeded(headless: boolean = false): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    // Step 1: Handle authentication
    let credentials = await readCredentials();
    let newAuth = false;

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth(headless);
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
        newAuth = true;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }

    // Make sure we have a machine ID
    // Server machine entity will be created either by the daemon or by the CLI
    const settings = await updateSettings(async s => {
        if (newAuth || !s.machineId) {
            return {
                ...s,
                machineId: randomUUID()
            };
        }
        return s;
    });

    logger.debug(`[AUTH] Machine ID: ${settings.machineId}`);

    return { credentials, machineId: settings.machineId! };
}