import { describe, expect, it } from 'vitest';

import { serializeErrorForLog } from './serializeErrorForLog';

describe('serializeErrorForLog', () => {
    it('preserves Error diagnostics', () => {
        const error = new Error('boom');
        const serialized = serializeErrorForLog(error);

        expect(serialized).toMatchObject({
            name: 'Error',
            message: 'boom',
        });
        expect(serialized.stack).toEqual(expect.any(String));
    });

    it('adds diagnostics for empty object rejections', () => {
        const serialized = serializeErrorForLog({});

        expect(serialized).toMatchObject({
            type: '[object Object]',
            constructorName: 'Object',
            value: '[object Object]',
        });
    });

    it('serializes primitive rejections', () => {
        expect(serializeErrorForLog(undefined)).toMatchObject({
            type: 'undefined',
            value: 'undefined',
        });
    });
});
