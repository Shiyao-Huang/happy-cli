import { describe, expect, it } from 'vitest';

import {
    DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS,
    buildModelSelfAwarenessPrompt,
    isRecognizedModelId,
    resolveContextWindowTokens,
} from './modelContextWindows';

describe('modelContextWindows', () => {
    it('resolves known Claude model families to context window tokens', () => {
        expect(resolveContextWindowTokens('claude-sonnet-4-6')).toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS);
        expect(resolveContextWindowTokens('claude-opus-4-20250514')).toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS);
    });

    it('falls back to the default Claude context window for versioned variants', () => {
        expect(resolveContextWindowTokens('claude-sonnet-4-6-20250929')).toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS);
        expect(resolveContextWindowTokens('claude-haiku-4-5-preview')).toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS);
    });

    it('builds a prompt block that includes current model and context window', () => {
        const prompt = buildModelSelfAwarenessPrompt({
            modelId: 'claude-sonnet-4-6',
            fallbackModelId: 'claude-haiku-4-5',
            contextWindowTokens: DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS,
        });

        expect(prompt).toContain('Runtime Model Identity');
        expect(prompt).toContain('claude-sonnet-4-6');
        expect(prompt).toContain('claude-haiku-4-5');
        expect(prompt).toContain(`${DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS}`);
    });

    it('recognizes supported Claude model ids and rejects garbage values', () => {
        expect(isRecognizedModelId('claude-sonnet-4-6')).toBe(true);
        expect(isRecognizedModelId('claude-haiku-4-5-preview')).toBe(true);
        expect(isRecognizedModelId('definitely-not-a-real-model')).toBe(false);
    });
});
