import fs from 'node:fs';
import path from 'node:path';

export type RuntimeLogKind = 'history' | 'session';
export type RuntimeType = 'claude' | 'codex' | 'open-code';

export type RuntimeLogReadResult = {
    runtimeType: RuntimeType;
    logKind: RuntimeLogKind;
    sessionId?: string;
    cursorType: 'line' | 'byte';
    fromCursor: number;
    nextCursor: number;
    totalCount: number;
    hasNewContent: boolean;
    entries: Array<unknown>;
    filePath: string;
};

export type TeamRuntimeLogEntry = {
    ahaSessionId: string;
    claudeLocalSessionId?: string;
    runtimeType: RuntimeType;
    role?: string;
    pid: number;
    /**
     * Session identifier supervisors/help-agents must pass to read_runtime_log.
     * For Claude this is the claudeLocalSessionId, not the Aha session id.
     */
    readSessionId: string | null;
    /**
     * Key supervisors should persist in ccLogCursors/codexSessionCursors when
     * saving incremental runtime log progress.
     */
    cursorKey: string | null;
    logFilePath: string | null;
    logFileSize: number | null;
    historyFilePath?: string | null;
};

export function parseJsonLine(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return line;
    }
}

export function resolveMappedCursor(requestedCursor: number, envJson: string | undefined, key: string): number {
    if (requestedCursor >= 0) return requestedCursor;
    try {
        const parsed = JSON.parse(envJson || '{}') as Record<string, unknown>;
        const value = parsed[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    } catch {
        return 0;
    }
}

export function resolveLineCursor(requestedCursor: number, envValue: string | undefined): number {
    if (requestedCursor >= 0) return requestedCursor;
    const parsed = Number.parseInt(envValue || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function readJsonlByLineCursor(filePath: string, fromCursor: number, limit: number): RuntimeLogReadResult {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const safeCursor = Math.max(0, fromCursor);
    const newLines = lines.slice(safeCursor, safeCursor + limit).map(parseJsonLine);
    return {
        runtimeType: 'codex',
        logKind: 'history',
        cursorType: 'line',
        fromCursor: safeCursor,
        nextCursor: safeCursor + newLines.length,
        totalCount: lines.length,
        hasNewContent: newLines.length > 0,
        entries: newLines,
        filePath,
    };
}

export function readJsonlByByteOffset(filePath: string, fromCursor: number, limit: number): Omit<RuntimeLogReadResult, 'runtimeType' | 'logKind'> {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const safeCursor = Math.min(Math.max(0, fromCursor), fileSize);
    const remainingSize = Math.max(0, fileSize - safeCursor);
    const buffer = Buffer.alloc(remainingSize);
    const fd = fs.openSync(filePath, 'r');
    try {
        if (remainingSize > 0) {
            fs.readSync(fd, buffer, 0, remainingSize, safeCursor);
        }
    } finally {
        fs.closeSync(fd);
    }

    const entries = buffer.toString('utf-8').split('\n').filter(Boolean).slice(0, limit).map(parseJsonLine);
    return {
        cursorType: 'byte',
        fromCursor: safeCursor,
        nextCursor: fileSize,
        totalCount: fileSize,
        hasNewContent: entries.length > 0,
        entries,
        filePath,
    };
}

export function findClaudeLogFile(homeDir: string, sessionId: string): string | null {
    const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
    if (!fs.existsSync(claudeProjectsDir)) return null;

    for (const dir of fs.readdirSync(claudeProjectsDir)) {
        const candidate = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
    }

    return null;
}

/**
 * Finds the most recently modified Claude session log file under ~/.claude/projects/.
 * Used as a fallback when claudeSessionId has not yet been captured from the SDK stream
 * (race condition at session startup).
 *
 * @param homeDir   Home directory (defaults to process.env.HOME)
 * @param maxAgeMs  Only consider files modified within this window (default: 120 000 ms)
 */
export function findMostRecentClaudeLogFile(homeDir: string, maxAgeMs = 120_000): string | null {
    const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
    if (!fs.existsSync(claudeProjectsDir)) return null;

    const cutoff = Date.now() - maxAgeMs;
    let best: { path: string; mtime: number } | null = null;

    for (const dir of fs.readdirSync(claudeProjectsDir)) {
        const projectDir = path.join(claudeProjectsDir, dir);
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(projectDir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const full = path.join(projectDir, entry.name);
            try {
                const { mtimeMs } = fs.statSync(full);
                if (mtimeMs >= cutoff && (!best || mtimeMs > best.mtime)) {
                    best = { path: full, mtime: mtimeMs };
                }
            } catch {
                // skip unreadable files
            }
        }
    }

    return best?.path ?? null;
}

function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectFilesRecursive(full, acc);
        } else if (entry.isFile()) {
            acc.push(full);
        }
    }

    return acc;
}

export function findCodexTranscriptFile(homeDir: string, sessionId: string): string | null {
    const roots = [
        path.join(homeDir, '.codex', 'sessions'),
        path.join(homeDir, '.codex', 'archived_sessions'),
    ];

    const candidates = roots
        .flatMap((root) => collectFilesRecursive(root))
        .filter((filePath) => filePath.endsWith(`-${sessionId}.jsonl`))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    return candidates[0] || null;
}

/**
 * Finds the most recently modified Codex session transcript file.
 * Used as a fallback when the aha session ID does not match the Codex internal UUID
 * (which is the typical case: Codex files are named with their own UUID, not the aha session ID).
 *
 * @param homeDir   Home directory (defaults to process.env.HOME)
 * @param maxAgeMs  Only consider files modified within this window (default: 12 hours)
 */
export function findMostRecentCodexTranscriptFile(homeDir: string, maxAgeMs = 12 * 60 * 60 * 1000): string | null {
    const roots = [
        path.join(homeDir, '.codex', 'sessions'),
    ];
    const cutoff = Date.now() - maxAgeMs;
    let best: { path: string; mtime: number } | null = null;

    for (const root of roots) {
        for (const filePath of collectFilesRecursive(root)) {
            if (!filePath.endsWith('.jsonl')) continue;
            try {
                const { mtimeMs } = fs.statSync(filePath);
                if (mtimeMs >= cutoff && (!best || mtimeMs > best.mtime)) {
                    best = { path: filePath, mtime: mtimeMs };
                }
            } catch {
                // skip unreadable files
            }
        }
    }

    return best?.path ?? null;
}

export function readRuntimeLog(options: {
    homeDir?: string;
    runtimeType: RuntimeType;
    sessionId?: string;
    logKind?: RuntimeLogKind;
    fromCursor: number;
    limit: number;
    ccLogCursorsEnv?: string;
    codexHistoryCursorEnv?: string;
    codexSessionCursorsEnv?: string;
}): RuntimeLogReadResult {
    const {
        runtimeType,
        sessionId,
        fromCursor,
        limit,
        ccLogCursorsEnv,
        codexHistoryCursorEnv,
        codexSessionCursorsEnv,
    } = options;
    const logKind = options.logKind || (runtimeType === 'codex' ? 'history' : 'session');
    const homeDir = options.homeDir || process.env.HOME || '/tmp';

    if (runtimeType === 'claude') {
        if (!sessionId) throw new Error('sessionId is required to read Claude logs');
        const filePath = findClaudeLogFile(homeDir, sessionId);
        if (!filePath) throw new Error(`No Claude log found for session ${sessionId}`);
        const resolvedCursor = resolveMappedCursor(fromCursor, ccLogCursorsEnv, sessionId);
        return {
            runtimeType,
            logKind: 'session',
            sessionId,
            ...readJsonlByByteOffset(filePath, resolvedCursor, limit),
        };
    }

    if (runtimeType === 'codex' && logKind === 'history') {
        const filePath = path.join(homeDir, '.codex', 'history.jsonl');
        if (!fs.existsSync(filePath)) throw new Error('Codex history log not found');
        const resolvedCursor = resolveLineCursor(fromCursor, codexHistoryCursorEnv);
        return {
            ...readJsonlByLineCursor(filePath, resolvedCursor, limit),
            runtimeType,
            logKind,
        };
    }

    if (runtimeType === 'codex' && logKind === 'session') {
        if (!sessionId) throw new Error('sessionId is required to read Codex session logs');
        const filePath = findCodexTranscriptFile(homeDir, sessionId);
        if (!filePath) throw new Error(`No Codex transcript found for session ${sessionId}`);
        const resolvedCursor = resolveMappedCursor(fromCursor, codexSessionCursorsEnv, sessionId);
        return {
            runtimeType,
            logKind,
            sessionId,
            ...readJsonlByByteOffset(filePath, resolvedCursor, limit),
        };
    }

    throw new Error(`Unsupported runtime/log combination: ${runtimeType}/${logKind}`);
}

export function resolveTeamRuntimeLogs(
    sessions: Array<{ ahaSessionId: string; claudeLocalSessionId?: string; runtimeType?: string; role?: string; pid: number }>,
    homeDir: string,
): TeamRuntimeLogEntry[] {
    const codexHistoryPath = path.join(homeDir, '.codex', 'history.jsonl');

    return sessions.map((session) => {
        const runtimeType = ((session.runtimeType || (session.claudeLocalSessionId ? 'claude' : 'codex')) as RuntimeType);
        const logFilePath = runtimeType === 'claude'
            ? (session.claudeLocalSessionId ? findClaudeLogFile(homeDir, session.claudeLocalSessionId) : null)
            : findCodexTranscriptFile(homeDir, session.ahaSessionId);
        const readSessionId = runtimeType === 'claude'
            ? (session.claudeLocalSessionId ?? null)
            : session.ahaSessionId;

        return {
            ahaSessionId: session.ahaSessionId,
            claudeLocalSessionId: session.claudeLocalSessionId,
            runtimeType,
            role: session.role,
            pid: session.pid,
            readSessionId,
            cursorKey: readSessionId,
            logFilePath,
            logFileSize: logFilePath && fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : null,
            historyFilePath: runtimeType === 'codex' && fs.existsSync(codexHistoryPath) ? codexHistoryPath : null,
        };
    });
}
