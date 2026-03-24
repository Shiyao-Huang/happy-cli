import { describe, expect, it } from 'vitest';

import { applyMetadataUpdates } from './agents';

describe('applyMetadataUpdates model validation', () => {
    it('accepts recognized Claude model overrides', () => {
        expect(applyMetadataUpdates({}, {
            model: 'claude-opus-4-5',
            fallbackModel: 'claude-haiku-4-5',
        })).toMatchObject({
            modelOverride: 'claude-opus-4-5',
            fallbackModelOverride: 'claude-haiku-4-5',
        });
    });

    it('rejects unknown model overrides', () => {
        expect(() => applyMetadataUpdates({}, {
            model: 'definitely-not-a-real-model',
        })).toThrow('Unknown model ID');
    });
});
