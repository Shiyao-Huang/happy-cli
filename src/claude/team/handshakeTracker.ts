/**
 * handshakeTracker.ts — Track agent handshake ack state per team.
 *
 * When an agent joins a team, a pending handshake record is written.
 * When the agent replies with a handshake-ack message, the record is
 * marked verified.  Supervisor uses getStaleHandshakes() on each cycle
 * to detect agents that never acked within the timeout window.
 *
 * Storage: {cwd}/.aha/teams/{teamId}/handshakes.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface HandshakeRecord {
    sessionId: string;
    role: string;
    specId: string | null;
    sentAt: number;          // Unix ms when handshake was sent
    verified: boolean;
    ackAt: number | null;    // Unix ms when ack was received
    ackPayload: HandshakeAckPayload | null;
    alertedStale: boolean;   // true once a stale-alert was sent (prevents repeat alerts)
}

export interface HandshakeAckPayload {
    handshakeAck: true;
    readSystemMd: boolean;
    knowsAtHelp: boolean;
    role: string;
    specId: string;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const HANDSHAKE_TIMEOUT_MS = 60_000;

// ── Path helper ──────────────────────────────────────────────────────────────

function handshakesPath(cwd: string, teamId: string): string {
    return join(cwd, '.aha', 'teams', teamId, 'handshakes.json');
}

// ── Read / Write ─────────────────────────────────────────────────────────────

async function readHandshakes(cwd: string, teamId: string): Promise<HandshakeRecord[]> {
    try {
        const raw = await readFile(handshakesPath(cwd, teamId), 'utf-8');
        return JSON.parse(raw) as HandshakeRecord[];
    } catch {
        return [];
    }
}

async function writeHandshakes(cwd: string, teamId: string, records: HandshakeRecord[]): Promise<void> {
    const filePath = handshakesPath(cwd, teamId);
    await mkdir(join(cwd, '.aha', 'teams', teamId), { recursive: true });
    await writeFile(filePath, JSON.stringify(records, null, 2), 'utf-8');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a pending handshake when an agent joins and sends its intro message.
 */
export async function recordPendingHandshake(
    cwd: string,
    teamId: string,
    sessionId: string,
    role: string,
    specId: string | null,
): Promise<void> {
    const records = await readHandshakes(cwd, teamId);

    // Upsert: remove any existing record for this session
    const filtered = records.filter((r) => r.sessionId !== sessionId);
    filtered.push({
        sessionId,
        role,
        specId,
        sentAt: Date.now(),
        verified: false,
        ackAt: null,
        ackPayload: null,
        alertedStale: false,
    });

    await writeHandshakes(cwd, teamId, filtered);
    logger.debug(`[handshakeTracker] Recorded pending handshake for ${sessionId} (${role}) in team ${teamId}`);
}

/**
 * Mark a handshake as verified when we receive a valid ack message.
 * Returns true if a pending record was found and updated.
 */
export async function markHandshakeVerified(
    cwd: string,
    teamId: string,
    sessionId: string,
    ackPayload: HandshakeAckPayload,
): Promise<boolean> {
    const records = await readHandshakes(cwd, teamId);
    const record = records.find((r) => r.sessionId === sessionId && !r.verified);

    if (!record) {
        logger.debug(`[handshakeTracker] No pending handshake for ${sessionId} — ignoring ack`);
        return false;
    }

    record.verified = true;
    record.ackAt = Date.now();
    record.ackPayload = ackPayload;

    await writeHandshakes(cwd, teamId, records);
    logger.debug(`[handshakeTracker] Verified handshake for ${sessionId} (readSystemMd=${ackPayload.readSystemMd}, knowsAtHelp=${ackPayload.knowsAtHelp})`);
    return true;
}

/**
 * Parse an incoming team message content for a handshake-ack JSON block.
 * Returns the ack payload if found, null otherwise.
 */
export function parseHandshakeAck(content: string): HandshakeAckPayload | null {
    // Try to extract JSON from the message content.
    // Agents may wrap it in markdown code blocks or send it inline.
    const jsonPatterns = [
        /```json?\s*\n?([\s\S]*?)\n?\s*```/,    // fenced code block
        /(\{[\s\S]*"handshakeAck"\s*:\s*true[\s\S]*\})/,  // inline JSON
    ];

    for (const pattern of jsonPatterns) {
        const match = content.match(pattern);
        if (!match) continue;

        try {
            const parsed = JSON.parse(match[1]);
            if (
                parsed.handshakeAck === true &&
                typeof parsed.readSystemMd === 'boolean' &&
                typeof parsed.knowsAtHelp === 'boolean' &&
                typeof parsed.role === 'string'
            ) {
                return {
                    handshakeAck: true,
                    readSystemMd: parsed.readSystemMd,
                    knowsAtHelp: parsed.knowsAtHelp,
                    role: parsed.role,
                    specId: parsed.specId || '',
                };
            }
        } catch {
            // Not valid JSON, try next pattern
        }
    }

    return null;
}

/**
 * Get handshakes that are past the timeout, still unverified, and not yet
 * alerted.  Marks returned records as alertedStale=true so the caller
 * does not re-alert on the next cycle.
 */
export async function getStaleHandshakes(
    cwd: string,
    teamId: string,
    timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<HandshakeRecord[]> {
    const records = await readHandshakes(cwd, teamId);
    const now = Date.now();

    const stale = records.filter(
        (r) => !r.verified && !r.alertedStale && (now - r.sentAt) > timeoutMs,
    );

    if (stale.length > 0) {
        // Mark as alerted so we don't repeat
        for (const s of stale) {
            s.alertedStale = true;
        }
        await writeHandshakes(cwd, teamId, records);
    }

    return stale;
}

/**
 * Check if a specific session has a verified handshake.
 */
export async function isHandshakeVerified(
    cwd: string,
    teamId: string,
    sessionId: string,
): Promise<boolean> {
    const records = await readHandshakes(cwd, teamId);
    return records.some((r) => r.sessionId === sessionId && r.verified);
}

/**
 * Clean up old handshake records (older than maxAge).
 * Call periodically to prevent unbounded growth.
 */
export async function cleanupOldHandshakes(
    cwd: string,
    teamId: string,
    maxAgeMs: number = 24 * 60 * 60 * 1000, // 24h default
): Promise<number> {
    const records = await readHandshakes(cwd, teamId);
    const cutoff = Date.now() - maxAgeMs;
    const fresh = records.filter((r) => r.sentAt > cutoff);
    const removed = records.length - fresh.length;

    if (removed > 0) {
        await writeHandshakes(cwd, teamId, fresh);
        logger.debug(`[handshakeTracker] Cleaned up ${removed} old handshake records for team ${teamId}`);
    }

    return removed;
}
