import { describe, expect, it } from 'vitest';

import { resolveInitialModelOverrides } from './modelOverrides';

describe('resolveInitialModelOverrides', () => {
    it('uses session metadata for both primary and fallback model overrides by default', () => {
        expect(resolveInitialModelOverrides({
            modelOverride: 'claude-sonnet-4-5',
            fallbackModelOverride: 'claude-haiku-4-5',
        })).toEqual({
            model: 'claude-sonnet-4-5',
            fallbackModel: 'claude-haiku-4-5',
        });
    });

    it('lets an explicit CLI model override the stored primary model while preserving fallback metadata', () => {
        expect(resolveInitialModelOverrides({
            modelOverride: 'claude-sonnet-4-5',
            fallbackModelOverride: 'claude-haiku-4-5',
        }, 'claude-opus-4-5')).toEqual({
            model: 'claude-opus-4-5',
            fallbackModel: 'claude-haiku-4-5',
        });
    });
});
