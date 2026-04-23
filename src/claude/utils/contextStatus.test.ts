import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getContextStatusReport } from './contextStatus';

describe('getContextStatusReport', () => {
    it('reads Claude usage from the local Claude session log', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'aha-context-claude-'));
        const projectsDir = join(homeDir, '.claude', 'projects', 'repo');
        mkdirSync(projectsDir, { recursive: true });

        const filePath = join(projectsDir, 'claude-local-1.jsonl');
        writeFileSync(filePath, [
            JSON.stringify({
                type: 'assistant',
                message: {
                    usage: {
                        input_tokens: 100000,
                        output_tokens: 2000,
                        cache_creation_input_tokens: 10000,
                        cache_read_input_tokens: 20000,
                    },
                },
            }),
        ].join('\n'), 'utf-8');

        const report = getContextStatusReport({
            homeDir,
            ahaSessionId: 'aha-session-1',
            metadata: {
                claudeSessionId: 'claude-local-1',
                flavor: 'claude',
            } as any,
        });

        expect(report.runtimeType).toBe('claude');
        expect(report.available).toBe(true);
        expect(report.currentContextK).toBe(130);
        expect(report.usedPercent).toBe(65);
        expect(report.status).toContain('MODERATE');
    });

    it('reads Codex token_count usage from the current transcript', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'aha-context-codex-'));
        const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '03', '20');
        mkdirSync(sessionDir, { recursive: true });

        const filePath = join(sessionDir, 'rollout-2026-03-20T00-00-00-aha-session-2.jsonl');
        writeFileSync(filePath, [
            JSON.stringify({
                timestamp: '2026-03-20T00:00:00.000Z',
                type: 'event_msg',
                payload: {
                    type: 'token_count',
                    info: {
                        total_token_usage: {
                            input_tokens: 12000,
                            cached_input_tokens: 3000,
                            output_tokens: 500,
                            reasoning_output_tokens: 100,
                        },
                        last_token_usage: {
                            input_tokens: 12000,
                            cached_input_tokens: 3000,
                            output_tokens: 500,
                            reasoning_output_tokens: 100,
                        },
                        model_context_window: 30000,
                    },
                    rate_limits: {
                        primary: { used_percent: 29 },
                    },
                },
            }),
        ].join('\n'), 'utf-8');

        const report = getContextStatusReport({
            homeDir,
            ahaSessionId: 'aha-session-2',
            metadata: {
                flavor: 'codex',
            } as any,
        });

        expect(report.runtimeType).toBe('codex');
        expect(report.available).toBe(true);
        expect(report.currentContextK).toBe(15);
        expect(report.contextLimitK).toBe(30);
        expect(report.usedPercent).toBe(50);
        expect(report.status).toContain('MODERATE');
        expect(report.rateLimits).toBeDefined();
    });

    it('does not use an unrelated recent Codex transcript for explicit target inspection', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'aha-context-codex-target-'));
        const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '03', '20');
        mkdirSync(sessionDir, { recursive: true });

        writeFileSync(join(sessionDir, 'rollout-2026-03-20T00-00-00-other-codex-session.jsonl'), [
            JSON.stringify({
                timestamp: '2026-03-20T00:00:00.000Z',
                type: 'event_msg',
                payload: {
                    type: 'token_count',
                    info: {
                        last_token_usage: { input_tokens: 12000, cached_input_tokens: 3000 },
                        model_context_window: 30000,
                    },
                },
            }),
        ].join('\n'), 'utf-8');

        const report = getContextStatusReport({
            homeDir,
            ahaSessionId: 'target-aha-session',
            requestedSessionId: 'target-aha-session',
            allowRecentFallback: false,
            metadata: {
                flavor: 'codex',
            } as any,
        });

        expect(report.available).toBe(false);
        expect(report.runtimeType).toBe('codex');
        expect(report.diagnostics?.join('\n')).toContain('Recent transcript fallback disabled');
    });

    it('prefers resolvedModel context window over stale session metadata for Claude', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'aha-context-claude-resolved-model-'));
        const projectsDir = join(homeDir, '.claude', 'projects', 'repo');
        mkdirSync(projectsDir, { recursive: true });

        const filePath = join(projectsDir, 'claude-local-2.jsonl');
        writeFileSync(filePath, [
            JSON.stringify({
                type: 'assistant',
                message: {
                    usage: {
                        input_tokens: 100000,
                        output_tokens: 2000,
                        cache_creation_input_tokens: 10000,
                        cache_read_input_tokens: 20000,
                    },
                },
            }),
        ].join('\n'), 'utf-8');

        const report = getContextStatusReport({
            homeDir,
            ahaSessionId: 'aha-session-3',
            metadata: {
                claudeSessionId: 'claude-local-2',
                flavor: 'claude',
                resolvedModel: 'claude-sonnet-4-6',
                contextWindowTokens: 200000,
            } as any,
        });

        expect(report.contextLimitK).toBe(1000);
        expect(report.usedPercent).toBe(13);
        expect(report.status).toContain('LOW');
    });

    it('returns an unavailable report instead of throwing when a target Claude log is missing', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'aha-context-missing-claude-'));
        mkdirSync(join(homeDir, '.claude', 'projects'), { recursive: true });

        const report = getContextStatusReport({
            homeDir,
            ahaSessionId: 'aha-session-missing',
            requestedSessionId: 'claude-local-missing',
            metadata: {
                flavor: 'claude',
                claudeSessionId: 'claude-local-missing',
            } as any,
        });

        expect(report.available).toBe(false);
        expect(report.runtimeType).toBe('claude');
        expect(report.status).toContain('UNAVAILABLE');
        expect(report.diagnostics?.join('\n')).toContain('claudeSessionId=claude-local-missing');
    });
});
