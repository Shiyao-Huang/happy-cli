import axios from 'axios';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { encodeBase64, decodeBase64 } from './encryption';
import { configuration } from '@/configuration';
import tweetnacl from 'tweetnacl';

const SUPABASE_URL_ENV_NAME = 'SUPABASE_URL';
const SUPABASE_ANON_KEY_ENV_NAME = 'SUPABASE_ANON_KEY';
const JWT_LIKE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function resolveSupabaseUrl(envUrl = process.env.SUPABASE_URL): string {
    const trimmed = envUrl?.trim();
    if (trimmed) {
        return trimmed;
    }

    throw new Error(`Missing required ${SUPABASE_URL_ENV_NAME}`);
}

export function isLikelySupabaseAnonKey(value: string): boolean {
    return JWT_LIKE_PATTERN.test(value.trim());
}

export function resolveSupabaseAnonKey(envKey = process.env.SUPABASE_ANON_KEY): string {
    const trimmed = envKey?.trim();
    if (trimmed && isLikelySupabaseAnonKey(trimmed)) {
        return trimmed;
    }

    if (!trimmed) {
        throw new Error(`Missing required ${SUPABASE_ANON_KEY_ENV_NAME}`);
    }

    throw new Error(`Invalid ${SUPABASE_ANON_KEY_ENV_NAME}`);
}

function getSupabaseConfig(): { url: string; anonKey: string } {
    return {
        url: resolveSupabaseUrl(),
        anonKey: resolveSupabaseAnonKey(),
    };
}

function prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/**
 * Send OTP to email via Supabase.
 */
async function sendOtp(email: string): Promise<void> {
    const { url, anonKey } = getSupabaseConfig();
    const response = await axios.post(`${url}/auth/v1/otp`, {
        email,
    }, {
        headers: {
            'apikey': anonKey,
            'Content-Type': 'application/json',
        },
    });

    if (response.status !== 200) {
        throw new Error(`Failed to send OTP: ${response.statusText}`);
    }
}

/**
 * Verify OTP and get Supabase access token.
 */
async function verifyOtp(email: string, token: string): Promise<string> {
    const { url, anonKey } = getSupabaseConfig();
    const response = await axios.post(`${url}/auth/v1/verify`, {
        email,
        token,
        type: 'email',
    }, {
        headers: {
            'apikey': anonKey,
            'Content-Type': 'application/json',
        },
    });

    if (!response.data?.access_token) {
        throw new Error('OTP verification failed');
    }

    return response.data.access_token;
}

function generateRecoveryKeyPair() {
    const secret = new Uint8Array(randomBytes(tweetnacl.box.secretKeyLength));
    return tweetnacl.box.keyPair.fromSecretKey(secret);
}

function decryptRecoveredSecret(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    const ephemeralPublicKey = encryptedBundle.slice(0, tweetnacl.box.publicKeyLength);
    const nonce = encryptedBundle.slice(
        tweetnacl.box.publicKeyLength,
        tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength,
    );
    const encrypted = encryptedBundle.slice(tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);
    return tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
}

type SupabaseCompleteResult =
    | ({ state: 'existing_recovered' } & EmailOtpResult)
    | ({ state: 'new_account_created' } & EmailOtpResult)
    | { state: 'migration_required' };

async function fetchWrappingPublicKey(accessToken: string): Promise<Uint8Array | null> {
    try {
        const response = await axios.get<{ wrappingPublicKey: string }>(
            `${configuration.serverUrl}/v1/auth/wrapping-key`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        return decodeBase64(response.data.wrappingPublicKey);
    } catch {
        return null;
    }
}

async function buildSupabaseCompleteSecretPayload(accessToken: string, contentSecretKey: Uint8Array): Promise<Record<string, string>> {
    const wrappingPublicKey = await fetchWrappingPublicKey(accessToken);
    if (!wrappingPublicKey) {
        return {
            newContentSecretKey: encodeBase64(contentSecretKey),
        };
    }

    const ephemeral = tweetnacl.box.keyPair();
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength);
    const ciphertext = tweetnacl.box(contentSecretKey, nonce, wrappingPublicKey, ephemeral.secretKey);

    return {
        newEncryptedContentSecretKey: encodeBase64(ciphertext),
        newNonce: encodeBase64(nonce),
        newEphemeralPublicKey: encodeBase64(ephemeral.publicKey),
    };
}

async function completeWithServer(accessToken: string): Promise<SupabaseCompleteResult> {
    const keypair = generateRecoveryKeyPair();
    const newSecret = new Uint8Array(randomBytes(32));
    const secretPayload = await buildSupabaseCompleteSecretPayload(accessToken, newSecret);
    const response = await axios.post(`${configuration.serverUrl}/v1/auth/supabase/complete`, {
        accessToken,
        recoveryPublicKey: encodeBase64(keypair.publicKey),
        ...secretPayload,
    });

    if (response.data.state === 'migration_required') {
        return { state: 'migration_required' };
    }

    if (response.data.state === 'existing_recovered') {
        const encryptedContentSecretKey = decodeBase64(response.data.encryptedContentSecretKey);
        const secret = decryptRecoveredSecret(encryptedContentSecretKey, keypair.secretKey);
        if (!secret) {
            throw new Error('Failed to decrypt recovered account secret');
        }

        return {
            state: 'existing_recovered',
            secret,
            token: response.data.token,
            userId: response.data.userId,
        };
    }

    return {
        state: 'new_account_created',
        secret: newSecret,
        token: response.data.token,
        userId: response.data.userId,
    };
}

export interface EmailOtpResult {
    secret: Uint8Array;
    token: string;
    userId: string;
}

/**
 * Full CLI Email OTP login flow.
 * Returns secret + server token for credential storage.
 */
export async function doEmailOtpAuth(): Promise<EmailOtpResult | null> {
    const email = await prompt('Enter your email: ');
    if (!email) {
        console.log('No email provided.');
        return null;
    }

    console.log(`Sending verification code to ${email}...`);
    try {
        await sendOtp(email);
    } catch (error) {
        console.error('Failed to send verification code:', error instanceof Error ? error.message : error);
        return null;
    }

    console.log('Code sent! Check your email.');
    const code = await prompt('Enter 6-digit code: ');
    if (!code) {
        console.log('No code provided.');
        return null;
    }

    console.log('Verifying...');
    let accessToken: string;
    try {
        accessToken = await verifyOtp(email, code);
    } catch (error) {
        console.error('Verification failed:', error instanceof Error ? error.message : error);
        return null;
    }

    try {
        const result = await completeWithServer(accessToken);
        if (result.state === 'migration_required') {
            console.log('\nThis account needs to be migrated to Google sign-in.');
            console.log('On another signed-in device, run: aha auth show-join-code');
            console.log('Then run the generated command on this device to join.\n');
            return null;
        }
        return {
            secret: result.secret,
            token: result.token,
            userId: result.userId,
        };
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 409) {
            const code = error.response.data?.code;
            if (code === 'ACCOUNT_LINK_CONFLICT') {
                console.log('\nThis sign-in identity conflicts with an existing account.');
                console.log('On another signed-in device, run: aha auth show-join-code');
                console.log('Then run the generated command on this device to join.\n');
                return null;
            }
        }
        console.error('Server authentication failed:', error instanceof Error ? error.message : error);
        return null;
    }
}

export { SUPABASE_ANON_KEY_ENV_NAME, SUPABASE_URL_ENV_NAME };
