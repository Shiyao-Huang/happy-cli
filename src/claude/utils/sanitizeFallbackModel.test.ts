import { describe, expect, it } from 'vitest';

import { sanitizeFallbackModel } from './sanitizeFallbackModel';

describe('sanitizeFallbackModel', () => {
    it('keeps distinct fallback models', () => {
        expect(sanitizeFallbackModel('claude-sonnet-4-6', 'claude-haiku-4-6')).toBe('claude-haiku-4-6');
    });

    it('drops fallback models that match the primary model', () => {
        expect(sanitizeFallbackModel('claude-sonnet-4-6', 'claude-sonnet-4-6')).toBeUndefined();
    });

    it('preserves undefined values', () => {
        expect(sanitizeFallbackModel('claude-sonnet-4-6', undefined)).toBeUndefined();
        expect(sanitizeFallbackModel(undefined, 'claude-haiku-4-6')).toBe('claude-haiku-4-6');
    });
});
