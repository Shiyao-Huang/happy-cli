import { describe, expect, it } from 'vitest';
import { serializeErrorForLog } from './serializeErrorForLog';

describe('serializeErrorForLog', () => {
    it('preserves core error fields', () => {
        const error = new Error('boom');
        const result = serializeErrorForLog(error);

        expect(result.name).toBe('Error');
        expect(result.message).toBe('boom');
        expect(typeof result.stack).toBe('string');
    });

    it('serializes non-error objects as-is', () => {
        const result = serializeErrorForLog({ reason: 'bad-state' });
        expect(result).toEqual({ reason: 'bad-state' });
    });
});
