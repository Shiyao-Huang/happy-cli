/**
 * Backup key formatting utilities
 * Formats secret keys in the same way as the mobile client for compatibility
 */

// Base32 alphabet (RFC 4648) - excludes confusing characters
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function bytesToBase32(bytes: Uint8Array): string {
    let result = '';
    let buffer = 0;
    let bufferLength = 0;

    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;

        while (bufferLength >= 5) {
            bufferLength -= 5;
            result += BASE32_ALPHABET[(buffer >> bufferLength) & 0x1f];
        }
    }

    // Handle remaining bits
    if (bufferLength > 0) {
        result += BASE32_ALPHABET[(buffer << (5 - bufferLength)) & 0x1f];
    }

    return result;
}

function base32ToBytes(base32: string): Uint8Array {
    const cleaned = base32.replace(/[-\s]/g, '').toUpperCase();
    const bytes: number[] = [];
    let buffer = 0;
    let bufferLength = 0;

    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) throw new Error(`Invalid base32 character: ${char}`);
        buffer = (buffer << 5) | value;
        bufferLength += 5;

        if (bufferLength >= 8) {
            bufferLength -= 8;
            bytes.push((buffer >> bufferLength) & 0xff);
        }
    }

    return new Uint8Array(bytes);
}

/**
 * Parses a backup key string back to 32-byte secret.
 * Accepts two formats:
 *   - base32 with dashes: "XXXXX-XXXXX-XXXXX-..." (from secretKeyFormatted)
 *   - base64url: "vmIUkAx5FRdN..." (from secretKeyBase64url)
 * Auto-detects format by checking for lowercase/base64 chars.
 */
export function parseBackupKeyToSecret(backupKey: string): Uint8Array {
    const trimmed = backupKey.trim();

    // base64url detection: contains lowercase or +/_ or ends with =, and no dashes
    const looksBase64 = /^[A-Za-z0-9_\-+=\/]+$/.test(trimmed) && /[a-z]/.test(trimmed);

    if (looksBase64) {
        // base64url → standard base64 → bytes
        const standard = trimmed.replace(/-/g, '+').replace(/_/g, '/');
        const binary = Buffer.from(standard, 'base64');
        if (binary.length < 32) {
            throw new Error(`Backup key too short: got ${binary.length} bytes, expected 32`);
        }
        return new Uint8Array(binary.buffer, binary.byteOffset, 32);
    }

    // base32 with dashes
    const bytes = base32ToBytes(trimmed);
    if (bytes.length < 32) {
        throw new Error(`Backup key too short: got ${bytes.length} bytes, expected 32`);
    }
    return bytes.slice(0, 32);
}

/**
 * Formats a secret key for display in a user-friendly format matching mobile client
 * @param secretBytes - 32-byte secret key as Uint8Array
 * @returns Formatted string like "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
 */
export function formatSecretKeyForBackup(secretBytes: Uint8Array): string {
    // Convert to base32
    const base32 = bytesToBase32(secretBytes);

    // Split into groups of 5 characters
    const groups: string[] = [];
    for (let i = 0; i < base32.length; i += 5) {
        groups.push(base32.slice(i, i + 5));
    }

    // Join with dashes
    // 32 bytes = 256 bits = 52 base32 chars (51.2 rounded up)
    // That's approximately 11 groups of 5 chars
    return groups.join('-');
}