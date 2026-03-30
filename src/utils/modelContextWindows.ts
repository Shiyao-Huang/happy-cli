export const DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;
export const CLAUDE_1M_CONTEXT_WINDOW_TOKENS = 1_000_000;

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    // Claude Code runs all current-gen models with 1M context window
    // Updated 2026-03-21 per user confirmation (Claude Code = 1M, not 200K)
    'claude-opus-4': DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS,
    'claude-opus-4-1': DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS,
    'claude-opus-4-6': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-opus-4-6': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-opus-4-20250514': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-sonnet-4': DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS,
    'claude-sonnet-4-6': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-sonnet-4-6': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-sonnet-4-20250514': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-haiku-4': DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS,
    'claude-haiku-4-6': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    // Explicit [1m] variants retained for backward compat
    'claude-opus-4-6[1m]': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-opus-4-6[1m]': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-sonnet-4-6[1m]': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-sonnet-4-6[1m]': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    'claude-haiku-4-6[1m]': CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
};

export function resolveContextWindowTokens(modelId?: string | null): number | undefined {
    const normalized = modelId?.trim();
    if (!normalized) return undefined;

    const exactMatch = MODEL_CONTEXT_WINDOWS[normalized];
    if (exactMatch) return exactMatch;

    const prefixMatch = Object.entries(MODEL_CONTEXT_WINDOWS).find(([knownModel]) =>
        normalized.startsWith(`${knownModel}-`)
    );
    if (prefixMatch) {
        return prefixMatch[1];
    }

    if (normalized.startsWith('claude-')) {
        return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS;
    }

    return undefined;
}

export function isRecognizedModelId(modelId?: string | null): boolean {
    const normalized = modelId?.trim();
    if (!normalized) return false;

    if (Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_WINDOWS, normalized)) {
        return true;
    }

    return Object.keys(MODEL_CONTEXT_WINDOWS).some((knownModel) =>
        normalized.startsWith(`${knownModel}-`)
    );
}

export function buildModelSelfAwarenessPrompt(opts: {
    modelId?: string | null;
    fallbackModelId?: string | null;
    contextWindowTokens?: number;
}): string {
    const lines = ['## Runtime Model Identity'];

    if (opts.modelId) {
        lines.push(`- Current model: ${opts.modelId}`);
    }
    if (opts.fallbackModelId) {
        lines.push(`- Fallback model: ${opts.fallbackModelId}`);
    }
    if (typeof opts.contextWindowTokens === 'number') {
        lines.push(`- Context window: ${opts.contextWindowTokens} tokens`);
    }

    return lines.length > 1 ? lines.join('\n') : '';
}
