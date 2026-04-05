import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({ debug: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: mockLogger }));

import type { AgentImage } from '@/api/types/genome';
import { createHotEvolutionTick } from './hotEvolutionTick';

function makeImage(version: number, prompt = 'prompt'): AgentImage {
    return { version, systemPrompt: prompt } as AgentImage;
}

describe('createHotEvolutionTick', () => {
    beforeEach(() => {
        mockLogger.debug.mockReset();
    });

    it('version bump → updates ref.current and calls onVersionBump', async () => {
        const ref: { current: AgentImage | null | undefined } = { current: makeImage(1) };
        const onVersionBump = vi.fn();
        const newImage = makeImage(2, 'evolved');
        const fetchFn = vi.fn().mockResolvedValue(newImage);

        const tick = createHotEvolutionTick({
            token: 'tok',
            specId: 'spec-1',
            agentImageRef: ref,
            initialVersion: 1,
            fetchFn,
            onVersionBump,
        });

        await tick();

        expect(ref.current).toBe(newImage);
        expect(onVersionBump).toHaveBeenCalledOnce();
        expect(onVersionBump).toHaveBeenCalledWith(newImage);
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining('v1 → v2'),
        );
    });

    it('same version → no update, no callback', async () => {
        const image = makeImage(3);
        const ref: { current: AgentImage | null | undefined } = { current: image };
        const onVersionBump = vi.fn();
        const fetchFn = vi.fn().mockResolvedValue(makeImage(3, 'same'));

        const tick = createHotEvolutionTick({
            token: 'tok',
            specId: 'spec-1',
            agentImageRef: ref,
            initialVersion: 3,
            fetchFn,
            onVersionBump,
        });

        await tick();

        expect(ref.current).toBe(image); // unchanged
        expect(onVersionBump).not.toHaveBeenCalled();
    });

    it('older version → no update, no callback', async () => {
        const image = makeImage(5);
        const ref: { current: AgentImage | null | undefined } = { current: image };
        const onVersionBump = vi.fn();
        const fetchFn = vi.fn().mockResolvedValue(makeImage(2));

        const tick = createHotEvolutionTick({
            token: 'tok',
            specId: 'spec-1',
            agentImageRef: ref,
            initialVersion: 5,
            fetchFn,
            onVersionBump,
        });

        await tick();

        expect(ref.current).toBe(image);
        expect(onVersionBump).not.toHaveBeenCalled();
    });

    it('fetch returns null → no-op', async () => {
        const image = makeImage(1);
        const ref: { current: AgentImage | null | undefined } = { current: image };
        const onVersionBump = vi.fn();
        const fetchFn = vi.fn().mockResolvedValue(null);

        const tick = createHotEvolutionTick({
            token: 'tok',
            specId: 'spec-1',
            agentImageRef: ref,
            initialVersion: 1,
            fetchFn,
            onVersionBump,
        });

        await tick();

        expect(ref.current).toBe(image);
        expect(onVersionBump).not.toHaveBeenCalled();
    });

    it('fetch throws → swallows error, logs debug, no crash', async () => {
        const ref: { current: AgentImage | null | undefined } = { current: undefined };
        const onVersionBump = vi.fn();
        const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));

        const tick = createHotEvolutionTick({
            token: 'tok',
            specId: 'spec-1',
            agentImageRef: ref,
            initialVersion: 0,
            fetchFn,
            onVersionBump,
        });

        await expect(tick()).resolves.toBeUndefined();
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining('network down'),
        );
        expect(onVersionBump).not.toHaveBeenCalled();
    });

    it('multiple ticks: version advances twice, each bump fires callback', async () => {
        const ref: { current: AgentImage | null | undefined } = { current: makeImage(1) };
        const onVersionBump = vi.fn();
        const v2 = makeImage(2);
        const v3 = makeImage(3);
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(v2)
            .mockResolvedValueOnce(v3);

        const tick = createHotEvolutionTick({
            token: 'tok',
            specId: 'spec-1',
            agentImageRef: ref,
            initialVersion: 1,
            fetchFn,
            onVersionBump,
        });

        await tick();
        expect(ref.current).toBe(v2);
        expect(onVersionBump).toHaveBeenCalledTimes(1);

        await tick();
        expect(ref.current).toBe(v3);
        expect(onVersionBump).toHaveBeenCalledTimes(2);
    });
});
