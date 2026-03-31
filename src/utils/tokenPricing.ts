/**
 * Token Pricing — Anthropic model pricing tables and cost calculation
 *
 * Prices are in USD per 1M tokens. Updated for Claude 4.x family models.
 * Cache pricing follows Anthropic's published rates:
 *   - cache_creation: 1.25x of input price
 *   - cache_read: 0.1x of input price
 */

export interface TokenPricing {
    /** USD per 1M input tokens */
    inputPer1M: number;
    /** USD per 1M output tokens */
    outputPer1M: number;
    /** USD per 1M cache creation tokens (typically 1.25x input) */
    cacheCreationPer1M: number;
    /** USD per 1M cache read tokens (typically 0.1x input) */
    cacheReadPer1M: number;
}

export interface CostBreakdown {
    total: number;
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
}

export interface TokenUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

/**
 * Pricing table for Anthropic Claude models.
 *
 * Model IDs use the canonical short form (e.g. "claude-sonnet-4-6").
 * Resolution logic tries exact match first, then prefix match,
 * then falls back to a family-level default.
 */
export const MODEL_PRICING: Record<string, TokenPricing> = {
    // ── Opus 4.x family ─────────────────────────────────────────────
    'claude-opus-4': {
        inputPer1M: 15,
        outputPer1M: 75,
        cacheCreationPer1M: 18.75,
        cacheReadPer1M: 1.5,
    },
    'claude-opus-4-1': {
        inputPer1M: 15,
        outputPer1M: 75,
        cacheCreationPer1M: 18.75,
        cacheReadPer1M: 1.5,
    },
    'claude-opus-4-6': {
        inputPer1M: 15,
        outputPer1M: 75,
        cacheCreationPer1M: 18.75,
        cacheReadPer1M: 1.5,
    },

    // ── Sonnet 4.x family ───────────────────────────────────────────
    'claude-sonnet-4': {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheCreationPer1M: 3.75,
        cacheReadPer1M: 0.3,
    },
    'claude-sonnet-4-6': {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheCreationPer1M: 3.75,
        cacheReadPer1M: 0.3,
    },

    // ── Haiku 4.x family ────────────────────────────────────────────
    'claude-haiku-4': {
        inputPer1M: 0.80,
        outputPer1M: 4,
        cacheCreationPer1M: 1,
        cacheReadPer1M: 0.08,
    },
    'claude-haiku-4-6': {
        inputPer1M: 0.80,
        outputPer1M: 4,
        cacheCreationPer1M: 1,
        cacheReadPer1M: 0.08,
    },
};

/**
 * Default pricing used when model ID is unknown or unrecognized.
 * Uses Sonnet pricing as a reasonable middle-ground estimate.
 */
export const DEFAULT_PRICING: TokenPricing = {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheCreationPer1M: 3.75,
    cacheReadPer1M: 0.3,
};

/**
 * Resolve pricing for a given model ID.
 *
 * Resolution order:
 * 1. Exact match in MODEL_PRICING
 * 2. Prefix match (e.g. "claude-sonnet-4-20250514" matches "claude-sonnet-4")
 * 3. DEFAULT_PRICING
 */
export function resolvePricing(modelId?: string | null): TokenPricing {
    const normalized = modelId?.trim();
    if (!normalized) return DEFAULT_PRICING;

    const exact = MODEL_PRICING[normalized];
    if (exact) return exact;

    const prefixMatch = Object.entries(MODEL_PRICING).find(([key]) =>
        normalized.startsWith(`${key}-`)
    );
    if (prefixMatch) return prefixMatch[1];

    return DEFAULT_PRICING;
}

/**
 * Calculate cost breakdown for a set of token usage.
 *
 * @param usage   - Token counts from Claude's usage field
 * @param modelId - Model identifier for pricing lookup (optional)
 * @returns Cost breakdown in USD (all values rounded to 8 decimal places)
 */
export function calculateCost(usage: TokenUsage, modelId?: string | null): CostBreakdown {
    const pricing = resolvePricing(modelId);

    const inputCost = (usage.input_tokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.outputPer1M;
    const cacheCreationCost = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.cacheCreationPer1M;
    const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.cacheReadPer1M;

    const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

    return {
        total: round8(inputCost + outputCost + cacheCreationCost + cacheReadCost),
        input: round8(inputCost),
        output: round8(outputCost),
        cacheCreation: round8(cacheCreationCost),
        cacheRead: round8(cacheReadCost),
    };
}
