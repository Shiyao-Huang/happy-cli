import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildToolInputShapeFromJsonSchema } from '../bridgeSchema';

describe('buildToolInputShapeFromJsonSchema', () => {
    it('converts required and optional string fields', () => {
        const shape = buildToolInputShapeFromJsonSchema({
            type: 'object',
            properties: {
                title: { type: 'string' },
                note: { type: 'string' },
            },
            required: ['title'],
        });

        expect(shape).toBeDefined();

        const schema = z.object(shape!);
        expect(schema.safeParse({ title: 'ok' }).success).toBe(true);
        expect(schema.safeParse({}).success).toBe(false);
        expect(schema.safeParse({ title: 'ok', note: 'hello' }).success).toBe(true);
    });

    it('supports enum and array fields used by MCP tools', () => {
        const shape = buildToolInputShapeFromJsonSchema({
            type: 'object',
            properties: {
                content: { type: 'string' },
                mentions: {
                    type: 'array',
                    items: { type: 'string' },
                },
                type: {
                    type: 'string',
                    enum: ['chat', 'task-update', 'notification'],
                },
                priority: {
                    type: 'string',
                    enum: ['normal', 'high', 'urgent'],
                },
            },
            required: ['content'],
        });

        expect(shape).toBeDefined();

        const schema = z.object(shape!);

        expect(
            schema.safeParse({
                content: 'hello',
                mentions: ['s1', 's2'],
                type: 'chat',
                priority: 'high',
            }).success,
        ).toBe(true);

        expect(schema.safeParse({ content: 'hello', type: 'invalid' }).success).toBe(false);
    });

    it('returns undefined for non-object top-level schema', () => {
        expect(buildToolInputShapeFromJsonSchema(undefined)).toBeUndefined();
        expect(buildToolInputShapeFromJsonSchema(null)).toBeUndefined();
        expect(buildToolInputShapeFromJsonSchema({ type: 'string' })).toBeUndefined();
    });
});
