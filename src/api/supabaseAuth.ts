import axios from 'axios';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { encodeBase64, authChallenge } from './encryption';
import { configuration } from '@/configuration';

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

/**
 * Exchange Supabase token + client secret for happy-server token.
 */
async function exchangeWithServer(accessToken: string, secret: Uint8Array): Promise<{ token: string; userId: string }> {
    const { challenge, publicKey, signature } = authChallenge(secret);

    const response = await axios.post(`${configuration.serverUrl}/v1/auth/supabase`, {
        accessToken,
        challenge: encodeBase64(challenge),
        publicKey: encodeBase64(publicKey),
        signature: encodeBase64(signature),
    });

    return {
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

    const secret = new Uint8Array(randomBytes(32));

    try {
        const result = await exchangeWithServer(accessToken, secret);
        return {
            secret,
            token: result.token,
            userId: result.userId,
        };
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 409) {
            const code = error.response.data?.code;
            if (code === 'RESTORE_REQUIRED') {
                console.log('\nThis email is already linked to an account.');
                console.log('Use --restore-key to restore your existing account:');
                console.log('  npx aha-v13 --restore-key XXXXX-XXXXX-...\n');
                return null;
            }
        }
        console.error('Server authentication failed:', error instanceof Error ? error.message : error);
        return null;
    }
}
