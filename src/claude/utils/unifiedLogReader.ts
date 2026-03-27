/**
 * Unified Log Reader
 *
 * Aggregates multiple log sources for a team into a single time-ordered stream:
 *   - Team messages          ({cwd}/.aha/teams/{teamId}/messages.jsonl)
 *   - Supervisor score log   ({cwd}/.aha/supervisor-logs/{teamId}.jsonl)
 *   - Help request events    ({cwd}/.aha/events/help_requests.jsonl)
 *   - Trace events           (~/.aha/trace/trace.db, filtered by teamId)
 *
 * Session logs (CC / Codex) are NOT included here — use read_runtime_log for those.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { configuration } from '@/configuration';

export type UnifiedLogSource = 'team' | 'supervisor' | 'help' | 'trace';

export type UnifiedLogEntry = {
    ts: number;
    source: UnifiedLogSource;
    kind: string;
    role?: string;
    sessionId?: string;
    content: string;
    raw?: unknown;
};

export type UnifiedLogResult = {
    teamId: string;
    sources: UnifiedLogSource[];
    fromTs: number;
    toTs: number;
    totalEntries: number;
    entries: UnifiedLogEntry[];
};

function readJsonlFile(filePath: string): unknown[] {
    if (!fs.existsSync(filePath)) return [];
    try {
        return fs.readFileSync(filePath, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean) as unknown[];
    } catch {
        return [];
    }
}

function safeTs(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
}

function readTeamMessages(
    cwd: string,
    teamId: string,
    fromTs: number,
    roles?: string[],
): UnifiedLogEntry[] {
    const filePath = path.join(cwd, '.aha', 'teams', teamId, 'messages.jsonl');
    const lines = readJsonlFile(filePath) as Array<Record<string, unknown>>;
    const entries: UnifiedLogEntry[] = [];

    for (const message of lines) {
        const ts = safeTs(message.timestamp ?? message.ts ?? message.createdAt);
        if (ts < fromTs) continue;

        const role = typeof message.fromRole === 'string'
            ? message.fromRole
            : typeof message.role === 'string'
                ? message.role
                : undefined;
        if (roles && roles.length > 0 && role && !roles.includes(role)) continue;

        entries.push({
            ts,
            source: 'team',
            kind: typeof message.type === 'string' ? message.type : 'message',
            role,
            sessionId: typeof message.fromSessionId === 'string'
                ? message.fromSessionId
                : typeof message.sessionId === 'string'
                    ? message.sessionId
                    : undefined,
            content: typeof message.content === 'string'
                ? message.content.slice(0, 500)
                : JSON.stringify(message.content).slice(0, 500),
            raw: message,
        });
    }

    return entries;
}

function readSupervisorLog(
    cwd: string,
    teamId: string,
    fromTs: number,
): UnifiedLogEntry[] {
    const filePath = path.join(cwd, '.aha', 'supervisor-logs', `${teamId}.jsonl`);
    const lines = readJsonlFile(filePath) as Array<Record<string, unknown>>;
    const entries: UnifiedLogEntry[] = [];

    for (const entry of lines) {
        const ts = safeTs(entry.timestamp);
        if (ts < fromTs) continue;

        const overall = typeof entry.overall === 'number' ? entry.overall : null;
        const action = typeof entry.action === 'string' ? entry.action : 'score';
        const role = typeof entry.role === 'string' ? entry.role : undefined;
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const summary = overall !== null
            ? `scored ${role ?? '?'}@${sessionId?.slice(0, 8) ?? '?'} -> ${overall}/100 (${action})`
            : `supervisor event (${action})`;

        entries.push({
            ts,
            source: 'supervisor',
            kind: 'score',
            role,
            sessionId,
            content: summary,
            raw: entry,
        });
    }

    return entries;
}

function readHelpRequests(
    cwd: string,
    teamId: string,
    fromTs: number,
): UnifiedLogEntry[] {
    const filePath = path.join(cwd, '.aha', 'events', 'help_requests.jsonl');
    const lines = readJsonlFile(filePath) as Array<Record<string, unknown>>;
    const entries: UnifiedLogEntry[] = [];

    for (const entry of lines) {
        if (entry.teamId !== teamId) continue;

        const ts = safeTs(entry.timestamp);
        if (ts < fromTs) continue;

        const role = typeof entry.role === 'string' ? entry.role : undefined;
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const description = typeof entry.description === 'string'
            ? entry.description.slice(0, 300)
            : '';

        entries.push({
            ts,
            source: 'help',
            kind: typeof entry.type === 'string' ? entry.type : 'help_request',
            role,
            sessionId,
            content: description,
            raw: entry,
        });
    }

    return entries;
}

function readTraceEvents(
    ahaHomeDir: string,
    teamId: string,
    fromTs: number,
    limit: number,
): UnifiedLogEntry[] {
    const dbPath = path.join(ahaHomeDir, 'trace', 'trace.db');
    if (!fs.existsSync(dbPath)) return [];

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const rows = db.prepare(
                `SELECT ts, kind, level, source, session_id, summary
                 FROM trace_events
                 WHERE team_id = ? AND ts >= ?
                 ORDER BY ts ASC
                 LIMIT ?`
            ).all(teamId, fromTs, limit) as Array<{
                ts: number;
                kind: string;
                level: string;
                source: string;
                session_id: string | null;
                summary: string | null;
            }>;

            return rows.map((row) => ({
                ts: row.ts,
                source: 'trace' as UnifiedLogSource,
                kind: row.kind,
                sessionId: row.session_id ?? undefined,
                content: row.summary ?? `${row.kind} [${row.source}]`,
                raw: row,
            }));
        } finally {
            db.close();
        }
    } catch {
        return [];
    }
}

export type ReadUnifiedLogOptions = {
    teamId: string;
    cwd: string;
    ahaHomeDir?: string;
    limit: number;
    fromTs: number;
    sources: UnifiedLogSource[];
    roles?: string[];
};

export function readUnifiedLog(options: ReadUnifiedLogOptions): UnifiedLogResult {
    const { teamId, cwd, limit, fromTs, sources, roles } = options;
    const ahaHomeDir = options.ahaHomeDir ?? configuration.ahaHomeDir;
    const all: UnifiedLogEntry[] = [];

    if (sources.includes('team')) {
        all.push(...readTeamMessages(cwd, teamId, fromTs, roles));
    }
    if (sources.includes('supervisor')) {
        all.push(...readSupervisorLog(cwd, teamId, fromTs));
    }
    if (sources.includes('help')) {
        all.push(...readHelpRequests(cwd, teamId, fromTs));
    }
    if (sources.includes('trace')) {
        all.push(...readTraceEvents(ahaHomeDir, teamId, fromTs, limit * 2));
    }

    all.sort((left, right) => left.ts - right.ts);

    const trimmed = all.slice(0, limit);
    const toTs = trimmed.length > 0 ? trimmed[trimmed.length - 1].ts : fromTs;

    return {
        teamId,
        sources,
        fromTs,
        toTs,
        totalEntries: trimmed.length,
        entries: trimmed,
    };
}
