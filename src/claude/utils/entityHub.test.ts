import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createEntityTrial, ensureEntityTrial } from './entityHub';

describe('entityHub trial helpers', () => {
    let postSpy: any;
    let getSpy: any;
    const originalPublishKey = process.env.HUB_PUBLISH_KEY;

    beforeEach(() => {
        process.env.HUB_PUBLISH_KEY = 'hub-publish-key';
        postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            data: { trial: { id: 'mock-trial-id' } },
        });
        getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            data: {},
        });
    });

    afterEach(() => {
        postSpy.mockRestore();
        getSpy.mockRestore();
        if (originalPublishKey === undefined) {
            delete process.env.HUB_PUBLISH_KEY;
        } else {
            process.env.HUB_PUBLISH_KEY = originalPublishKey;
        }
    });

    it('includes sessionId in the POST body when provided', async () => {
        await createEntityTrial({
            namespace: 'test-ns',
            name: 'test-entity',
            sessionId: 'test-session-abc-123',
        });

        expect(postSpy).toHaveBeenCalledOnce();
        const [url, body] = postSpy.mock.calls[0];
        expect(url).toContain('/entities/test-ns/test-entity/trials');
        expect(body).toEqual(
            expect.objectContaining({ sessionId: 'test-session-abc-123' }),
        );
    });

    it('defaults direct hub writes to HUB_PUBLISH_KEY when token is omitted', async () => {
        await createEntityTrial({
            namespace: 'test-ns',
            name: 'test-entity',
        });

        const [, , config] = postSpy.mock.calls[0];
        expect(config).toEqual(expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: 'Bearer hub-publish-key',
            }),
        }));
    });

    it('reuses an open entity trial for the same sessionId', async () => {
        getSpy
            .mockResolvedValueOnce({ data: { entity: { id: 'entity-1' } } })
            .mockResolvedValueOnce({
                data: {
                    trials: [
                        { id: 'trial-open', sessionId: 'session-1', endedAt: null },
                        { id: 'trial-old', sessionId: 'session-1', endedAt: '2026-04-03T00:00:00.000Z' },
                    ],
                },
            });

        const result = await ensureEntityTrial({
            namespace: 'ns',
            name: 'entity',
            sessionId: 'session-1',
        });

        expect(result).toEqual({ trial: { id: 'trial-open' } });
        expect(postSpy).not.toHaveBeenCalled();
    });

    it('creates a new entity trial when no open trial exists for the session', async () => {
        getSpy
            .mockResolvedValueOnce({ data: { entity: { id: 'entity-1' } } })
            .mockResolvedValueOnce({ data: { trials: [] } });

        const result = await ensureEntityTrial({
            namespace: 'ns',
            name: 'entity',
            sessionId: 'session-2',
        });

        expect(result).toEqual({ trial: { id: 'mock-trial-id' } });
        expect(postSpy).toHaveBeenCalledOnce();
    });
});
