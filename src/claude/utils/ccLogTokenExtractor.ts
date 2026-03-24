/**
 * CC Log Token Extraction — Extract cumulative token usage from Claude Code session logs
 *
 * Reads JSONL CC log entries and sums up usage fields from assistant messages.
 */

import { readRuntimeLog } from './runtimeLogReader';
import type { CostBreakdown, TokenUsage } from '@/utils/tokenPricing';
import { calculateCost } from '@/utils/tokenPricing';

export interface CcLogTokenSummary {
    /** Total input + output + cache tokens */
    totalTokens: number;
    /** Detailed token breakdown */
    tokens: {
        input: number;
        output: number;
        cacheCreation: number;
        cacheRead: number;
    };
    /** Cost breakdown (requires model ID for accurate pricing) */
    cost: CostBreakdown;
    /** Number of assistant messages with usage data */
    messageCount: number;
}

/**
 * Extract cumulative token usage from a Claude Code session's CC log.
 *
 * Reads the full JSONL session file and sums up `message.usage` from all
 * assistant-type entries. Returns null if the session log cannot be found
 * or read.
 *
 * @param sessionId   - Claude local session ID
 * @param homeDir     - Home directory (default: process.env.HOME)
 * @param modelId     - Model ID for cost calculation (optional)
 */
export function extractTokenUsageFromCcLog(
    sessionId: string,
    homeDir?: string,
    modelId?: string | null,
): CcLogTokenSummary | null {
    try {
        const result = readRuntimeLog({
            homeDir: homeDir || process.env.HOME || '/tmp',
            runtimeType: 'claude',
            sessionId,
            logKind: 'session',
            fromCursor: 0,
            limit: 100_000, // read entire log
        });

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheCreation = 0;
        let cacheRead = 0;
        let messageCount = 0;

        for (const entry of result.entries) {
            const parsed = entry as Record<string, unknown>;
            if (parsed.type !== 'assistant') continue;

            const message = parsed.message as Record<string, unknown> | undefined;
            if (!message?.usage) continue;

            const usage = message.usage as Record<string, unknown>;
            const inp = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
            const out = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
            const cc = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
            const cr = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;

            inputTokens += inp;
            outputTokens += out;
            cacheCreation += cc;
            cacheRead += cr;
            messageCount++;
        }

        const totalTokens = inputTokens + outputTokens + cacheCreation + cacheRead;

        const usageForCost: TokenUsage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreation,
            cache_read_input_tokens: cacheRead,
        };

        return {
            totalTokens,
            tokens: {
                input: inputTokens,
                output: outputTokens,
                cacheCreation,
                cacheRead,
            },
            cost: calculateCost(usageForCost, modelId),
            messageCount,
        };
    } catch {
        return null;
    }
}
