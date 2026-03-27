import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUnifiedLog } from './unifiedLogReader';

describe('readUnifiedLog', () => {
    it('aggregates team, supervisor, and help logs into a single ordered stream', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'aha-unified-log-'));
        const teamId = 'team-1';

        mkdirSync(join(cwd, '.aha', 'teams', teamId), { recursive: true });
        mkdirSync(join(cwd, '.aha', 'supervisor-logs'), { recursive: true });
        mkdirSync(join(cwd, '.aha', 'events'), { recursive: true });

        writeFileSync(
            join(cwd, '.aha', 'teams', teamId, 'messages.jsonl'),
            [
                JSON.stringify({
                    id: 'm1',
                    teamId,
                    fromSessionId: 's1',
                    fromRole: 'builder',
                    type: 'chat',
                    timestamp: 1000,
                    content: 'first team message',
                }),
                JSON.stringify({
                    id: 'm2',
                    teamId,
                    fromSessionId: 's2',
                    fromRole: 'supervisor',
                    type: 'notification',
                    timestamp: 4000,
                    content: 'later team message',
                }),
            ].join('\n'),
            'utf-8',
        );

        writeFileSync(
            join(cwd, '.aha', 'supervisor-logs', `${teamId}.jsonl`),
            JSON.stringify({
                timestamp: '1970-01-01T00:00:02.000Z',
                sessionId: 's3',
                role: 'builder',
                overall: 72,
                action: 'keep',
            }),
            'utf-8',
        );

        writeFileSync(
            join(cwd, '.aha', 'events', 'help_requests.jsonl'),
            [
                JSON.stringify({
                    timestamp: '1970-01-01T00:00:03.000Z',
                    teamId,
                    sessionId: 's4',
                    role: 'builder',
                    type: 'stuck',
                    description: 'need help quickly',
                }),
                JSON.stringify({
                    timestamp: '1970-01-01T00:00:05.000Z',
                    teamId: 'other-team',
                    sessionId: 'sx',
                    role: 'builder',
                    type: 'stuck',
                    description: 'should be filtered out',
                }),
            ].join('\n'),
            'utf-8',
        );

        const result = readUnifiedLog({
            teamId,
            cwd,
            ahaHomeDir: cwd,
            limit: 10,
            fromTs: 0,
            sources: ['team', 'supervisor', 'help'],
        });

        expect(result.entries).toHaveLength(4);
        expect(result.entries.map((entry) => entry.source)).toEqual([
            'team',
            'supervisor',
            'help',
            'team',
        ]);
        expect(result.entries.map((entry) => entry.ts)).toEqual([1000, 2000, 3000, 4000]);
    });

    it('filters team messages by role and respects fromTs', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'aha-unified-log-filter-'));
        const teamId = 'team-2';

        mkdirSync(join(cwd, '.aha', 'teams', teamId), { recursive: true });
        writeFileSync(
            join(cwd, '.aha', 'teams', teamId, 'messages.jsonl'),
            [
                JSON.stringify({
                    teamId,
                    fromSessionId: 's1',
                    fromRole: 'builder',
                    type: 'chat',
                    timestamp: 1000,
                    content: 'builder message',
                }),
                JSON.stringify({
                    teamId,
                    fromSessionId: 's2',
                    fromRole: 'supervisor',
                    type: 'chat',
                    timestamp: 2000,
                    content: 'supervisor message',
                }),
            ].join('\n'),
            'utf-8',
        );

        const result = readUnifiedLog({
            teamId,
            cwd,
            ahaHomeDir: cwd,
            limit: 10,
            fromTs: 1500,
            sources: ['team'],
            roles: ['supervisor'],
        });

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.role).toBe('supervisor');
        expect(result.entries[0]?.content).toContain('supervisor message');
    });
});
