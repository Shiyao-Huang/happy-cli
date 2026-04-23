import { describe, expect, it } from 'vitest';
import { stringifyForPrompt, truncateForPrompt } from './promptCompaction';

describe('promptCompaction', () => {
    it('leaves short text unchanged', () => {
        expect(truncateForPrompt('short', 20)).toBe('short');
    });

    it('keeps the head and tail when truncating long text', () => {
        const text = `${'a'.repeat(80)}${'b'.repeat(80)}${'c'.repeat(80)}`;
        const result = truncateForPrompt(text, 120, '[cut]');

        expect(result.length).toBeLessThanOrEqual(120);
        expect(result).toContain('[cut]');
        expect(result.startsWith('a')).toBe(true);
        expect(result.endsWith('c')).toBe(true);
    });

    it('bounds stringified team context', () => {
        const result = stringifyForPrompt({ tasks: Array.from({ length: 50 }, (_, index) => ({ index, body: 'x'.repeat(100) })) }, 500);

        expect(result.length).toBeLessThanOrEqual(500);
        expect(result).toContain('team context truncated');
    });
});
