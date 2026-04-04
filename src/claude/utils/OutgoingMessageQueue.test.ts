import { describe, expect, it } from 'vitest';

import { OutgoingMessageQueue } from './OutgoingMessageQueue';

async function flushQueue(queue: OutgoingMessageQueue): Promise<void> {
    await Promise.resolve();
    await queue.flush();
}

describe('OutgoingMessageQueue', () => {
    it('forwards system init messages to the client send function', async () => {
        const sent: any[] = [];
        const queue = new OutgoingMessageQueue((message) => {
            sent.push(message);
        });

        queue.enqueue({
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-1',
            tools: ['get_self_view'],
        });
        queue.enqueue({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [],
            },
        });

        await flushQueue(queue);

        expect(sent).toEqual([
            expect.objectContaining({
                type: 'system',
                subtype: 'init',
                tools: ['get_self_view'],
            }),
            expect.objectContaining({
                type: 'assistant',
            }),
        ]);

        queue.destroy();
    });

    it('continues to suppress non-init system messages', async () => {
        const sent: any[] = [];
        const queue = new OutgoingMessageQueue((message) => {
            sent.push(message);
        });

        queue.enqueue({
            type: 'system',
            subtype: 'heartbeat',
        });

        await flushQueue(queue);

        expect(sent).toEqual([]);

        queue.destroy();
    });
});
