import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    parseRetroAiResponse,
    appendConstraintsToAgentsMd,
    writeRetroReport,
    buildRetroSummaryText,
    type RetroReport,
} from './sprintRetro';

// ── parseRetroAiResponse ──────────────────────────────────────────────────────

describe('parseRetroAiResponse', () => {
    it('parses valid JSON correctly', () => {
        const input = JSON.stringify({
            wins: ['fast delivery', 'clean tests'],
            failures: ['staging conflict'],
            constraints: ['#1: tsc OOM'],
            nextSprintSuggestions: ['add serial lock'],
        });
        const result = parseRetroAiResponse(input);
        expect(result.wins).toEqual(['fast delivery', 'clean tests']);
        expect(result.failures).toEqual(['staging conflict']);
        expect(result.constraints).toEqual(['#1: tsc OOM']);
        expect(result.nextSprintSuggestions).toEqual(['add serial lock']);
    });

    it('strips markdown code fences before parsing', () => {
        const input = '```json\n{"wins":["ok"],"failures":[],"constraints":[],"nextSprintSuggestions":[]}\n```';
        const result = parseRetroAiResponse(input);
        expect(result.wins).toEqual(['ok']);
    });

    it('returns empty arrays on invalid JSON', () => {
        const result = parseRetroAiResponse('not valid json }{');
        expect(result.wins).toEqual([]);
        expect(result.failures).toEqual([]);
        expect(result.constraints).toEqual([]);
        expect(result.nextSprintSuggestions).toEqual([]);
    });

    it('coerces non-array fields to empty arrays', () => {
        const result = parseRetroAiResponse('{"wins":"single string","failures":null}');
        expect(result.wins).toEqual([]);
        expect(result.failures).toEqual([]);
    });
});

// ── appendConstraintsToAgentsMd ───────────────────────────────────────────────

describe('appendConstraintsToAgentsMd', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aha-retro-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('appends new constraints to AGENTS.md', () => {
        const mdPath = path.join(tmpDir, 'AGENTS.md');
        fs.writeFileSync(mdPath, '# AGENTS\n\n| 1 | existing constraint | manual | high |\n', 'utf-8');

        const count = appendConstraintsToAgentsMd(['new constraint discovered in sprint'], mdPath);
        expect(count).toBe(1);

        const content = fs.readFileSync(mdPath, 'utf-8');
        expect(content).toContain('new constraint discovered in sprint');
    });

    it('deduplicates constraints already present in AGENTS.md', () => {
        const mdPath = path.join(tmpDir, 'AGENTS.md');
        fs.writeFileSync(mdPath, '# AGENTS\n\nalready known constraint lives here\n', 'utf-8');

        const count = appendConstraintsToAgentsMd(['already known constraint lives here'], mdPath);
        expect(count).toBe(0);

        const content = fs.readFileSync(mdPath, 'utf-8');
        // Should not have duplicate
        const matches = (content.match(/already known constraint/g) || []).length;
        expect(matches).toBe(1);
    });

    it('no-ops if AGENTS.md does not exist', () => {
        const count = appendConstraintsToAgentsMd(['some constraint'], path.join(tmpDir, 'nonexistent.md'));
        expect(count).toBe(0);
    });

    it('no-ops when constraints array is empty', () => {
        const mdPath = path.join(tmpDir, 'AGENTS.md');
        fs.writeFileSync(mdPath, '# AGENTS\n', 'utf-8');
        const count = appendConstraintsToAgentsMd([], mdPath);
        expect(count).toBe(0);
    });
});

// ── writeRetroReport ──────────────────────────────────────────────────────────

describe('writeRetroReport', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aha-retro-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes retro JSON to the specified directory', () => {
        const report: RetroReport = {
            sprintId: 'N+3',
            teamId: 'team-123',
            generatedAt: '2026-03-26T00:00:00Z',
            fromDate: '2026-03-20',
            toDate: '2026-03-26',
            wins: ['delivered SYS-1'],
            failures: ['staging conflict'],
            constraints: ['#2: tsc OOM'],
            nextSprintSuggestions: ['add serial lock'],
            rawData: { completedTaskCount: 4, gitCommitCount: 5, scoringEventCount: 8 },
        };

        const retroDir = path.join(tmpDir, 'retros');
        const filePath = writeRetroReport(report, retroDir);

        expect(fs.existsSync(filePath)).toBe(true);
        const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        expect(written.sprintId).toBe('N+3');
        expect(written.wins).toEqual(['delivered SYS-1']);
    });

    it('creates the retro directory if it does not exist', () => {
        const report: RetroReport = {
            sprintId: 'N+4',
            teamId: 'team-x',
            generatedAt: '2026-03-27T00:00:00Z',
            fromDate: '2026-03-26',
            toDate: '2026-03-27',
            wins: [], failures: [], constraints: [], nextSprintSuggestions: [],
            rawData: { completedTaskCount: 0, gitCommitCount: 0, scoringEventCount: 0 },
        };
        const nestedDir = path.join(tmpDir, 'deep', 'nested', 'retros');
        const filePath = writeRetroReport(report, nestedDir);
        expect(fs.existsSync(filePath)).toBe(true);
    });
});

// ── buildRetroSummaryText ─────────────────────────────────────────────────────

describe('buildRetroSummaryText', () => {
    it('formats all sections correctly', () => {
        const report: RetroReport = {
            sprintId: 'N+3',
            teamId: 'team-abc',
            generatedAt: '2026-03-26T00:00:00Z',
            fromDate: '2026-03-20',
            toDate: '2026-03-26',
            wins: ['SYS-1 shipped', 'CONSTRAINT-2 fixed'],
            failures: ['Builder 2 git restore incident'],
            constraints: ['#2: concurrent tsc OOM'],
            nextSprintSuggestions: ['enforce tsc serial lock earlier'],
            rawData: { completedTaskCount: 4, gitCommitCount: 7, scoringEventCount: 12 },
        };

        const text = buildRetroSummaryText(report);
        expect(text).toContain('Sprint Retro: N+3');
        expect(text).toContain('Tasks: 4 done');
        expect(text).toContain('SYS-1 shipped');
        expect(text).toContain('Builder 2 git restore incident');
        expect(text).toContain('#2: concurrent tsc OOM');
        expect(text).toContain('enforce tsc serial lock earlier');
    });
});
