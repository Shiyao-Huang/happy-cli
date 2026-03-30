/**
 * Sprint Retrospective Utilities
 *
 * Collects sprint data from multiple sources and generates a structured
 * retrospective report via AI summarization (Claude Haiku).
 *
 * Used by the `generate_sprint_retro` MCP tool (supervisorTools.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RetroReport = {
    sprintId: string;
    teamId: string;
    generatedAt: string;
    fromDate: string;
    toDate: string;
    wins: string[];
    failures: string[];
    constraints: string[];
    nextSprintSuggestions: string[];
    rawData: {
        completedTaskCount: number;
        gitCommitCount: number;
        scoringEventCount: number;
    };
};

export type GatherRetroDataOptions = {
    sprintId: string;
    teamId: string;
    fromDate: string;   // ISO date string, e.g. "2026-03-20"
    toDate: string;
    cwd: string;        // project working directory (contains .aha/)
    repoPaths: string[];  // git repos to read commits from
    api: {
        listTasks(teamId: string, filters?: { status?: string }): Promise<{ tasks: any[] }>;
    };
};

// ── Data Gathering ────────────────────────────────────────────────────────────

/**
 * Collect all sprint data into a single text block for AI summarization.
 */
export async function gatherSprintData(opts: GatherRetroDataOptions): Promise<{
    rawText: string;
    completedTaskCount: number;
    gitCommitCount: number;
    scoringEventCount: number;
}> {
    const sections: string[] = [`=== Sprint ${opts.sprintId} Retrospective Data ===`, `Period: ${opts.fromDate} → ${opts.toDate}`, `Team: ${opts.teamId}`, ''];

    // 1. Completed tasks + recent comments
    let completedTaskCount = 0;
    try {
        const { tasks } = await opts.api.listTasks(opts.teamId, { status: 'done' });
        completedTaskCount = tasks.length;
        sections.push(`== Completed Tasks (${tasks.length}) ==`);
        for (const t of tasks.slice(0, 40)) {
            const lastComment = Array.isArray(t.comments) && t.comments.length > 0
                ? t.comments[t.comments.length - 1]
                : null;
            const summary = lastComment
                ? `  → ${String(lastComment.content || '').slice(0, 150)}`
                : '';
            sections.push(`- [${t.priority ?? '?'}] ${t.title}${summary}`);
        }
        sections.push('');
    } catch {
        sections.push('== Completed Tasks: unavailable ==', '');
    }

    // 2. Git commits across repos
    let gitCommitCount = 0;
    sections.push('== Git Commits ==');
    for (const repo of opts.repoPaths) {
        if (!fs.existsSync(repo)) continue;
        try {
            const log = execSync(
                `git log --oneline --since="${opts.fromDate}" --until="${opts.toDate}" 2>/dev/null`,
                { cwd: repo, encoding: 'utf-8', timeout: 10_000, shell: '/bin/zsh' }
            ).trim();
            if (log) {
                const lines = log.split('\n');
                gitCommitCount += lines.length;
                sections.push(`[${path.basename(repo)}]`);
                sections.push(...lines.slice(0, 20));
                sections.push('');
            }
        } catch { /* non-fatal */ }
    }
    if (gitCommitCount === 0) sections.push('(no commits in period)');
    sections.push('');

    // 3. Supervisor scores
    let scoringEventCount = 0;
    sections.push('== Supervisor Scores ==');
    const supervisorLogPath = path.join(opts.cwd, '.aha', 'supervisor-logs', `${opts.teamId}.jsonl`);
    if (fs.existsSync(supervisorLogPath)) {
        const fromTs = Date.parse(opts.fromDate);
        const toTs = Date.parse(opts.toDate + 'T23:59:59Z');
        const entries = fs.readFileSync(supervisorLogPath, 'utf-8')
            .split('\n').filter(Boolean)
            .map((l, idx) => {
                try {
                    return JSON.parse(l);
                } catch (error) {
                    if (process.env.NODE_ENV === 'development') {
                        console.error(`[DEV] Sprint log line ${idx} is malformed:`, error);
                        throw new Error(`Sprint log corrupted at line ${idx}: ${String(error)}`);
                    }
                    console.warn(`[PROD] Sprint log line ${idx} skipped (malformed)`, error);
                    return null;
                }
            })
            .filter((e: any): e is Record<string, unknown> => e !== null)
            .filter((e: any) => {
                const ts = typeof e.timestamp === 'number' ? e.timestamp : Date.parse(String(e.timestamp ?? ''));
                return ts >= fromTs && ts <= toTs;
            });
        scoringEventCount = entries.length;
        for (const e of entries.slice(-30) as any[]) {
            sections.push(`${e.role ?? '?'}@${String(e.sessionId ?? '').slice(0, 8)}: score=${e.overall ?? '?'} action=${e.action ?? 'score'}`);
        }
    }
    if (scoringEventCount === 0) sections.push('(no scoring events in period)');
    sections.push('');

    const rawText = sections.join('\n');
    return { rawText, completedTaskCount, gitCommitCount, scoringEventCount };
}

// ── AI Summarization ──────────────────────────────────────────────────────────

export type RetroAiOutput = {
    wins: string[];
    failures: string[];
    constraints: string[];
    nextSprintSuggestions: string[];
};

/**
 * Parse AI JSON response, with fallback to empty arrays on parse failure.
 */
export function parseRetroAiResponse(text: string): RetroAiOutput {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
        const parsed = JSON.parse(cleaned);
        return {
            wins: Array.isArray(parsed.wins) ? parsed.wins.map(String) : [],
            failures: Array.isArray(parsed.failures) ? parsed.failures.map(String) : [],
            constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(String) : [],
            nextSprintSuggestions: Array.isArray(parsed.nextSprintSuggestions) ? parsed.nextSprintSuggestions.map(String) : [],
        };
    } catch {
        return { wins: [], failures: [], constraints: [], nextSprintSuggestions: [] };
    }
}

/**
 * Call Claude Haiku to generate a structured sprint retrospective.
 * Falls back to empty output if ANTHROPIC_API_KEY is missing.
 */
export async function summarizeRetroWithAI(rawText: string): Promise<RetroAiOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return { wins: ['(AI summary unavailable — ANTHROPIC_API_KEY not set)'], failures: [], constraints: [], nextSprintSuggestions: [] };
    }

    try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });

        const response = await client.messages.create({
            model: 'claude-haiku-4-6',
            max_tokens: 1200,
            messages: [{
                role: 'user',
                content: `Analyze this Aha AI agent sprint data. Return ONLY a JSON object (no markdown, no explanation):
{"wins":["..."],"failures":["..."],"constraints":["..."],"nextSprintSuggestions":["..."]}

Rules:
- wins: what went well this sprint (3-5 concise items, ≤80 chars each)
- failures: what went wrong, blockers, rework (3-5 items)
- constraints: system-level limitations discovered, format "#N: description" (2-4 items)
- nextSprintSuggestions: specific actionable improvements (3-5 items)

Sprint data:
${rawText.slice(0, 5000)}`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
        return parseRetroAiResponse(text);
    } catch {
        return { wins: [], failures: [], constraints: ['(AI summarization failed — check ANTHROPIC_API_KEY)'], nextSprintSuggestions: [] };
    }
}

// ── Output Writers ────────────────────────────────────────────────────────────

/**
 * Write retro report to .aha/retros/{sprintId}.json.
 * Returns the path written.
 */
export function writeRetroReport(report: RetroReport, retroDir: string): string {
    fs.mkdirSync(retroDir, { recursive: true });
    const filePath = path.join(retroDir, `${report.sprintId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    return filePath;
}

/**
 * Append newly discovered constraints to AGENTS.md (deduplicated by first 50 chars).
 * No-ops if file doesn't exist or no new constraints.
 * Returns the number of constraints appended.
 */
export function appendConstraintsToAgentsMd(constraints: string[], agentsMdPath: string): number {
    if (constraints.length === 0 || !fs.existsSync(agentsMdPath)) return 0;

    const existing = fs.readFileSync(agentsMdPath, 'utf-8');
    const newItems = constraints.filter(c => {
        const key = c.slice(0, 50).toLowerCase().replace(/\s+/g, ' ').trim();
        return !existing.toLowerCase().includes(key);
    });

    if (newItems.length === 0) return 0;

    const appendBlock = [
        '',
        `<!-- Sprint retro auto-detected constraints (${new Date().toISOString().slice(0, 10)}) -->`,
        ...newItems.map((c, i) => `| auto-${i + 1} | ${c} | sprint-retro | medium |`),
    ].join('\n');

    fs.appendFileSync(agentsMdPath, appendBlock, 'utf-8');
    return newItems.length;
}

/**
 * Format a RetroReport into a human-readable team message.
 */
export function buildRetroSummaryText(report: RetroReport): string {
    const lines: string[] = [
        `## Sprint Retro: ${report.sprintId}`,
        `Period: ${report.fromDate} → ${report.toDate} | Tasks: ${report.rawData.completedTaskCount} done | Commits: ${report.rawData.gitCommitCount}`,
        '',
        `**✅ Wins (${report.wins.length})**`,
        ...report.wins.map(w => `- ${w}`),
        '',
        `**❌ Failures (${report.failures.length})**`,
        ...report.failures.map(f => `- ${f}`),
        '',
        `**⚠️ Constraints (${report.constraints.length})**`,
        ...report.constraints.map(c => `- ${c}`),
        '',
        `**💡 Next Sprint Suggestions (${report.nextSprintSuggestions.length})**`,
        ...report.nextSprintSuggestions.map(s => `- ${s}`),
    ];
    return lines.join('\n');
}
