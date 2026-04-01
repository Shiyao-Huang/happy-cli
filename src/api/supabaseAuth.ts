import axios from 'axios';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { encodeBase64, decodeBase64 } from './encryption';
import { configuration } from '@/configuration';
import tweetnacl from 'tweetnacl';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://cegpdcfsqcfowgwkpanl.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlZ3BkY2ZzcWNmb3dnd2twYW5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4ODM3MDcsImV4cCI6MjA5MDQ1OTcwN30.4Y2QD5oTjze_QxEAeTBPUYTbOhhCeCr-LRVyJoiIK64';

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
    const response = await axios.post(`${SUPABASE_URL}/auth/v1/otp`, {
        email,
    }, {
        headers: {
            'apikey': SUPABASE_ANON_KEY,
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
    const response = await axios.post(`${SUPABASE_URL}/auth/v1/verify`, {
        email,
        token,
        type: 'email',
    }, {
        headers: {
            'apikey': SUPABASE_ANON_KEY,
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

async function completeWithServer(accessToken: string): Promise<SupabaseCompleteResult> {
    const keypair = generateRecoveryKeyPair();
    const newSecret = new Uint8Array(randomBytes(32));
    const response = await axios.post(`${configuration.serverUrl}/v1/auth/supabase/complete`, {
        accessToken,
        recoveryPublicKey: encodeBase64(keypair.publicKey),
        newContentSecretKey: encodeBase64(newSecret),
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
            console.log('\nThis email is already linked to an account, but automatic recovery is not ready yet.');
            console.log('Use a backup key or a one-time link command from an existing device.\n');
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
                console.log('\nThis sign-in identity conflicts with an existing restore key mapping.');
                console.log('Use a backup key or a one-time join command from an existing device:');
                console.log('  npm i aha-agi && npx aha auth restore --code XXXXX-XXXXX-...\n');
                return null;
            }
        }
        console.error('Server authentication failed:', error instanceof Error ? error.message : error);
        return null;
    }
}
