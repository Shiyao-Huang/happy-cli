import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    recordPendingHandshake,
    markHandshakeVerified,
    parseHandshakeAck,
    getStaleHandshakes,
    isHandshakeVerified,
    cleanupOldHandshakes,
    HandshakeAckPayload,
} from './handshakeTracker';

describe('handshakeTracker', () => {
    let tmpDir: string;
    const TEAM_ID = 'test-team-001';

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'handshake-test-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('recordPendingHandshake', () => {
        it('should create a pending handshake record', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');

            const verified = await isHandshakeVerified(tmpDir, TEAM_ID, 'session-1');
            expect(verified).toBe(false);
        });

        it('should upsert: replace existing record for same session', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'scout', 'spec-xyz');

            // Only one record should exist; role should be updated
            const stale = await getStaleHandshakes(tmpDir, TEAM_ID, 0);
            expect(stale.length).toBe(1);
            expect(stale[0].role).toBe('scout');
        });
    });

    describe('markHandshakeVerified', () => {
        it('should mark a pending handshake as verified', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');

            const ackPayload: HandshakeAckPayload = {
                handshakeAck: true,
                readSystemMd: true,
                knowsAtHelp: true,
                role: 'builder',
                specId: 'spec-abc',
            };

            const updated = await markHandshakeVerified(tmpDir, TEAM_ID, 'session-1', ackPayload);
            expect(updated).toBe(true);

            const verified = await isHandshakeVerified(tmpDir, TEAM_ID, 'session-1');
            expect(verified).toBe(true);
        });

        it('should return false for unknown session', async () => {
            const ackPayload: HandshakeAckPayload = {
                handshakeAck: true,
                readSystemMd: true,
                knowsAtHelp: true,
                role: 'builder',
                specId: 'spec-abc',
            };

            const updated = await markHandshakeVerified(tmpDir, TEAM_ID, 'unknown-session', ackPayload);
            expect(updated).toBe(false);
        });

        it('should not re-verify already verified handshake', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');

            const ackPayload: HandshakeAckPayload = {
                handshakeAck: true,
                readSystemMd: true,
                knowsAtHelp: true,
                role: 'builder',
                specId: 'spec-abc',
            };

            await markHandshakeVerified(tmpDir, TEAM_ID, 'session-1', ackPayload);
            const secondAttempt = await markHandshakeVerified(tmpDir, TEAM_ID, 'session-1', ackPayload);
            expect(secondAttempt).toBe(false);
        });
    });

    describe('parseHandshakeAck', () => {
        it('should parse JSON in fenced code block', () => {
            const content = `Here is my ack:
\`\`\`json
{
  "handshakeAck": true,
  "readSystemMd": true,
  "knowsAtHelp": true,
  "role": "builder",
  "specId": "spec-123"
}
\`\`\``;
            const result = parseHandshakeAck(content);
            expect(result).not.toBeNull();
            expect(result!.handshakeAck).toBe(true);
            expect(result!.readSystemMd).toBe(true);
            expect(result!.knowsAtHelp).toBe(true);
            expect(result!.role).toBe('builder');
            expect(result!.specId).toBe('spec-123');
        });

        it('should parse inline JSON', () => {
            const content = 'My ack: {"handshakeAck": true, "readSystemMd": false, "knowsAtHelp": true, "role": "scout", "specId": "abc"}';
            const result = parseHandshakeAck(content);
            expect(result).not.toBeNull();
            expect(result!.readSystemMd).toBe(false);
            expect(result!.role).toBe('scout');
        });

        it('should return null for non-ack message', () => {
            const content = 'Just a regular team message, nothing to see here';
            const result = parseHandshakeAck(content);
            expect(result).toBeNull();
        });

        it('should return null for incomplete JSON', () => {
            const content = '{"handshakeAck": true, "role": "builder"}';
            const result = parseHandshakeAck(content);
            expect(result).toBeNull(); // missing readSystemMd and knowsAtHelp
        });
    });

    describe('getStaleHandshakes', () => {
        it('should return handshakes past timeout', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');

            // With timeout=0, any pending handshake is stale
            const stale = await getStaleHandshakes(tmpDir, TEAM_ID, 0);
            expect(stale.length).toBe(1);
            expect(stale[0].sessionId).toBe('session-1');
        });

        it('should not return verified handshakes', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');
            await markHandshakeVerified(tmpDir, TEAM_ID, 'session-1', {
                handshakeAck: true,
                readSystemMd: true,
                knowsAtHelp: true,
                role: 'builder',
                specId: 'spec-abc',
            });

            const stale = await getStaleHandshakes(tmpDir, TEAM_ID, 0);
            expect(stale.length).toBe(0);
        });

        it('should not return recently sent handshakes (within timeout)', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');

            // With timeout=999999999, nothing is stale yet
            const stale = await getStaleHandshakes(tmpDir, TEAM_ID, 999_999_999);
            expect(stale.length).toBe(0);
        });

        it('should mark stale records as alerted to prevent repeat alerts', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');

            // First call returns the stale record
            const firstCall = await getStaleHandshakes(tmpDir, TEAM_ID, 0);
            expect(firstCall.length).toBe(1);

            // Second call should return empty (already alerted)
            const secondCall = await getStaleHandshakes(tmpDir, TEAM_ID, 0);
            expect(secondCall.length).toBe(0);
        });
    });

    describe('cleanupOldHandshakes', () => {
        it('should remove records older than maxAge', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');

            // Cleanup with maxAge=0 removes everything
            const removed = await cleanupOldHandshakes(tmpDir, TEAM_ID, 0);
            expect(removed).toBe(1);

            const stale = await getStaleHandshakes(tmpDir, TEAM_ID, 0);
            expect(stale.length).toBe(0);
        });

        it('should keep recent records', async () => {
            await recordPendingHandshake(tmpDir, TEAM_ID, 'session-1', 'builder', 'spec-abc');

            // Cleanup with large maxAge keeps everything
            const removed = await cleanupOldHandshakes(tmpDir, TEAM_ID, 999_999_999);
            expect(removed).toBe(0);
        });
    });
});
