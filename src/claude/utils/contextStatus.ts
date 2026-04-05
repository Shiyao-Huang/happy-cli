import fs from 'node:fs';
import type { Metadata } from '@/api/types';
import { findClaudeLogFile, findCodexTranscriptFile, findMostRecentClaudeLogFile, findMostRecentCodexTranscriptFile } from './runtimeLogReader';
import { DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS, resolveContextWindowTokens } from '@/utils/modelContextWindows';

type ContextStatusReport = {
    runtimeType: 'claude' | 'codex';
    sourceFilePath: string;
    currentContextK: number;
    remainingK: number | null;
    usedPercent: number | null;
    status: string;
    turns: number;
    cumulativeCost?: {
        inputK: number;
        outputK: number;
    };
    recommendation: string;
    contextLimitK?: number | null;
    rateLimits?: unknown;
};

function classifyStatus(usedPercent: number | null): { status: string; recommendation: string } {
    if (usedPercent === null) {
        return {
            status: '⚪ UNKNOWN — context limit unavailable',
            recommendation: 'Context limit unavailable — keep working, but check again after large context loads',
        };
    }

    if (usedPercent >= 85) {
        return {
            status: '🔴 CRITICAL — context usage very high',
            recommendation: 'Context usage is very high — consider wrapping up current task',
        };
    }

    if (usedPercent >= 70) {
        return {
            status: '🟡 HIGH — monitor context usage',
            recommendation: 'Context usage is elevated — be mindful of remaining capacity',
        };
    }

    if (usedPercent >= 50) {
        return {
            status: '🟢 MODERATE — plenty remaining',
            recommendation: 'Context healthy — no action needed',
        };
    }

    return {
        status: '🟢 LOW — context is fresh',
        recommendation: 'Context healthy — no action needed',
    };
}

function roundK(tokens: number): number {
    return Math.round(tokens / 1000);
}

function safeReadLines(filePath: string): string[] {
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
}

function resolveClaudeContextLimitTokens(metadata?: Metadata | null): number {
    const persistedLimitTokens = typeof (metadata as any)?.contextWindowTokens === 'number'
        ? (metadata as any).contextWindowTokens
        : undefined;
    const resolvedModelLimitTokens = resolveContextWindowTokens((metadata as any)?.resolvedModel);

    return resolvedModelLimitTokens
        ?? persistedLimitTokens
        ?? DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS;
}

function buildClaudeContextStatus(filePath: string, contextLimitTokens?: number): ContextStatusReport {
    const lines = safeReadLines(filePath);
    let lastUsage: Record<string, number> | null = null;
    let totalInputK = 0;
    let totalOutputK = 0;
    let turns = 0;

    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry.type !== 'assistant') continue;
            const usage = entry.message?.usage;
            if (!usage) continue;
            lastUsage = usage;
            totalInputK += ((usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0)) / 1000;
            totalOutputK += (usage.output_tokens || 0) / 1000;
            turns += 1;
        } catch {
            // ignore malformed lines
        }
    }

    if (!lastUsage) {
        throw new Error('No usage data found in Claude log yet.');
    }

    const currentContextTokens =
        (lastUsage.input_tokens || 0) +
        (lastUsage.cache_creation_input_tokens || 0) +
        (lastUsage.cache_read_input_tokens || 0);
    const contextLimitK = roundK(contextLimitTokens ?? DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS);
    const usedPercent = contextLimitK
        ? Math.round((roundK(currentContextTokens) / contextLimitK) * 100)
        : null;
    const { status, recommendation } = classifyStatus(usedPercent);

    return {
        runtimeType: 'claude',
        sourceFilePath: filePath,
        currentContextK: roundK(currentContextTokens),
        remainingK: contextLimitK === null ? null : Math.max(0, contextLimitK - roundK(currentContextTokens)),
        usedPercent,
        status,
        turns,
        cumulativeCost: {
            inputK: Math.round(totalInputK),
            outputK: Math.round(totalOutputK),
        },
        recommendation,
        contextLimitK,
    };
}

function buildCodexContextStatus(filePath: string): ContextStatusReport {
    const lines = safeReadLines(filePath);
    let lastInfo: any = null;
    let lastRateLimits: any = null;
    let turns = 0;

    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            const payload = entry?.payload ?? entry?.item?.payload ?? entry;
            if (payload?.type !== 'token_count') continue;
            if (payload.info) {
                lastInfo = payload.info;
                turns += 1;
            }
            if (payload.rate_limits) {
                lastRateLimits = payload.rate_limits;
            }
        } catch {
            // ignore malformed lines
        }
    }

    if (!lastInfo?.last_token_usage) {
        throw new Error('No token_count usage data found in Codex transcript yet.');
    }

    const currentContextTokens =
        (lastInfo.last_token_usage.input_tokens || 0) +
        (lastInfo.last_token_usage.cached_input_tokens || 0);
    const contextLimitTokens = typeof lastInfo.model_context_window === 'number'
        ? lastInfo.model_context_window
        : null;
    const contextLimitK = contextLimitTokens === null ? null : roundK(contextLimitTokens);
    const usedPercent = contextLimitK
        ? Math.round((roundK(currentContextTokens) / contextLimitK) * 100)
        : null;
    const { status, recommendation } = classifyStatus(usedPercent);

    return {
        runtimeType: 'codex',
        sourceFilePath: filePath,
        currentContextK: roundK(currentContextTokens),
        remainingK: contextLimitK === null ? null : Math.max(0, contextLimitK - roundK(currentContextTokens)),
        usedPercent,
        status,
        turns,
        cumulativeCost: {
            inputK: roundK(lastInfo.total_token_usage?.input_tokens || 0),
            outputK: roundK(
                (lastInfo.total_token_usage?.output_tokens || 0) +
                (lastInfo.total_token_usage?.reasoning_output_tokens || 0)
            ),
        },
        recommendation,
        contextLimitK,
        rateLimits: lastRateLimits || undefined,
    };
}

export function getContextStatusReport(options: {
    homeDir?: string;
    metadata?: Metadata | null;
    ahaSessionId: string;
    requestedSessionId?: string;
}): ContextStatusReport {
    const homeDir = options.homeDir || process.env.HOME || '/tmp';
    const metadata = options.metadata || undefined;
    const requestedSessionId = options.requestedSessionId?.trim();

    const explicitClaudeFile = requestedSessionId ? findClaudeLogFile(homeDir, requestedSessionId) : null;
    if (explicitClaudeFile) {
        return buildClaudeContextStatus(explicitClaudeFile, resolveClaudeContextLimitTokens(metadata));
    }

    const explicitCodexFile = requestedSessionId ? findCodexTranscriptFile(homeDir, requestedSessionId) : null;
    if (explicitCodexFile) {
        return buildCodexContextStatus(explicitCodexFile);
    }

    const runtimeType = metadata?.flavor === 'codex' ? 'codex' : 'claude';
    if (runtimeType === 'codex') {
        // Priority order for Codex transcript discovery:
        // 1. metadata.codexTranscriptPath — stored at session start from session_meta event (most reliable)
        // 2. findCodexTranscriptFile by aha session ID — works only if Codex files happen to use the aha CUID (rare)
        // 3. findMostRecentCodexTranscriptFile — fallback for sessions that predate the path-capture fix
        const codexFile = ((metadata as any)?.codexTranscriptPath as string | undefined)
            || findCodexTranscriptFile(homeDir, options.ahaSessionId)
            || findMostRecentCodexTranscriptFile(homeDir);
        if (!codexFile) {
            throw new Error('Codex transcript not found. Cannot determine context status.');
        }
        return buildCodexContextStatus(codexFile);
    }

    const claudeSessionId = requestedSessionId || metadata?.claudeSessionId;
    if (!claudeSessionId) {
        // Race condition: session just started and SDK has not yet emitted the session ID.
        // Fall back to the most recently modified log file (within 2 min window).
        const fallbackFile = findMostRecentClaudeLogFile(homeDir);
        if (!fallbackFile) {
            throw new Error('Claude session ID not found and no recent log file available. Cannot determine context status.');
        }
        return buildClaudeContextStatus(fallbackFile, resolveClaudeContextLimitTokens(metadata));
    }
    const claudeFile = findClaudeLogFile(homeDir, claudeSessionId);
    if (!claudeFile) {
        throw new Error('Claude log not found. Cannot determine context status.');
    }
    return buildClaudeContextStatus(claudeFile, resolveClaudeContextLimitTokens(metadata));
}
