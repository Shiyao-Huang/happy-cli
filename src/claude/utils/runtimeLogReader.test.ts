import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readRuntimeLog } from './runtimeLogReader';

const tempDirs: string[] = [];

function makeTempHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-log-reader-'));
    tempDirs.push(dir);
    return dir;
}

function writeJsonl(filePath: string, rows: unknown[]): number[] {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const serialized = rows.map((row) => JSON.stringify(row));
    fs.writeFileSync(filePath, serialized.join('\n') + '\n', 'utf-8');

    const offsets: number[] = [0];
    let current = 0;
    for (const line of serialized) {
        current += Buffer.byteLength(line + '\n');
        offsets.push(current);
    }
    return offsets;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('readRuntimeLog', () => {
    it('reads Claude logs from the stored byte cursor when fromCursor is -1', () => {
        const homeDir = makeTempHome();
        const sessionId = 'claude-local-123';
        const filePath = path.join(homeDir, '.claude', 'projects', 'project-a', sessionId + '.jsonl');
        const offsets = writeJsonl(filePath, [
            { type: 'assistant', id: 1 },
            { type: 'assistant', id: 2 },
            { type: 'assistant', id: 3 },
        ]);

        const result = readRuntimeLog({
            homeDir,
            runtimeType: 'claude',
            sessionId,
            fromCursor: -1,
            limit: 10,
            ccLogCursorsEnv: JSON.stringify({ [sessionId]: offsets[1] }),
        });

        expect(result.runtimeType).toBe('claude');
        expect(result.cursorType).toBe('byte');
        expect(result.fromCursor).toBe(offsets[1]);
        expect(result.nextCursor).toBe(offsets[3]);
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toMatchObject({ id: 2 });
        expect(result.entries[1]).toMatchObject({ id: 3 });
        expect(result.filePath).toBe(filePath);
    });

    it('reads Codex history using the stored line cursor when fromCursor is -1', () => {
        const homeDir = makeTempHome();
        const filePath = path.join(homeDir, '.codex', 'history.jsonl');
        writeJsonl(filePath, [
            { session_id: 's-1', text: 'first' },
            { session_id: 's-2', text: 'second' },
            { session_id: 's-3', text: 'third' },
        ]);

        const result = readRuntimeLog({
            homeDir,
            runtimeType: 'codex',
            logKind: 'history',
            fromCursor: -1,
            limit: 10,
            codexHistoryCursorEnv: '1',
        });

        expect(result.runtimeType).toBe('codex');
        expect(result.logKind).toBe('history');
        expect(result.cursorType).toBe('line');
        expect(result.fromCursor).toBe(1);
        expect(result.nextCursor).toBe(3);
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toMatchObject({ session_id: 's-2' });
        expect(result.entries[1]).toMatchObject({ session_id: 's-3' });
        expect(result.filePath).toBe(filePath);
    });

    it('finds Codex transcript files and reads them from the stored byte cursor', () => {
        const homeDir = makeTempHome();
        const sessionId = 'codex-session-789';
        const filePath = path.join(homeDir, '.codex', 'archived_sessions', 'rollout-2026-03-18T00-00-00-' + sessionId + '.jsonl');
        const offsets = writeJsonl(filePath, [
            { type: 'session_meta', payload: { id: sessionId } },
            { type: 'event', payload: 'diff' },
            { type: 'event', payload: 'done' },
        ]);

        const result = readRuntimeLog({
            homeDir,
            runtimeType: 'codex',
            logKind: 'session',
            sessionId,
            fromCursor: -1,
            limit: 10,
            codexSessionCursorsEnv: JSON.stringify({ [sessionId]: offsets[1] }),
        });

        expect(result.runtimeType).toBe('codex');
        expect(result.logKind).toBe('session');
        expect(result.cursorType).toBe('byte');
        expect(result.fromCursor).toBe(offsets[1]);
        expect(result.nextCursor).toBe(offsets[3]);
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toMatchObject({ payload: 'diff' });
        expect(result.entries[1]).toMatchObject({ payload: 'done' });
        expect(result.filePath).toBe(filePath);
    });
});
