import { describe, expect, it, vi } from 'vitest';

import {
    buildBootstrapFallbackInstructions,
    hasOrgManagerBootstrapTask,
    resolveTeamContextGenomeForInjection,
} from './teamBootstrapInstructions';

describe('team bootstrap genome resolution', () => {
    it('uses the already-loaded genome without fetching again', async () => {
        const fetchAgentImage = vi.fn();
        const loadedGenome = { version: 3, systemPrompt: 'ready' };
        const agentImageRef = { current: loadedGenome };

        await expect(resolveTeamContextGenomeForInjection({
            token: 'token',
            specId: 'spec-1',
            startupGenome: null,
            agentImageRef,
            fetchAgentImage,
        })).resolves.toMatchObject({
            genome: loadedGenome,
            source: 'already-ready',
        });

        expect(fetchAgentImage).not.toHaveBeenCalled();
    });

    it('re-fetches the genome just-in-time when the startup genome is missing', async () => {
        const refreshedGenome = { version: 4, systemPrompt: 'fresh prompt' };
        const fetchAgentImage = vi.fn().mockResolvedValue(refreshedGenome);
        const agentImageRef = { current: null };
        const onGenomeResolved = vi.fn();

        await expect(resolveTeamContextGenomeForInjection({
            token: 'token',
            specId: 'spec-1',
            startupGenome: null,
            agentImageRef,
            fetchAgentImage,
            onGenomeResolved,
        })).resolves.toMatchObject({
            genome: refreshedGenome,
            source: 'jit-fetch',
        });

        expect(fetchAgentImage).toHaveBeenCalledWith('token', 'spec-1');
        expect(agentImageRef.current).toBe(refreshedGenome);
        expect(onGenomeResolved).toHaveBeenCalledWith(refreshedGenome);
    });

    it('returns a failed resolution instead of throwing when just-in-time fetch fails', async () => {
        const error = new Error('hub unavailable');
        const fetchAgentImage = vi.fn().mockRejectedValue(error);
        const agentImageRef = { current: null };

        await expect(resolveTeamContextGenomeForInjection({
            token: 'token',
            specId: 'spec-1',
            startupGenome: null,
            agentImageRef,
            fetchAgentImage,
        })).resolves.toMatchObject({
            genome: null,
            source: 'jit-fetch-failed',
            error,
        });
    });
});

describe('team bootstrap fallback instructions', () => {
    it('only treats org-manager with non-empty task prompt as a must-deliver bootstrap task', () => {
        expect(hasOrgManagerBootstrapTask('org-manager', 'build the team')).toBe(true);
        expect(hasOrgManagerBootstrapTask('org-manager', '   ')).toBe(false);
        expect(hasOrgManagerBootstrapTask('implementer', 'build the team')).toBe(false);
    });

    it('builds degraded instructions that preserve the startup task path', () => {
        const instructions = buildBootstrapFallbackInstructions({
            role: 'org-manager',
            specId: 'spec-1',
            resolutionSource: 'jit-fetch-failed',
        });

        expect(instructions).toContain('degraded bootstrap runtime');
        expect(instructions).toContain('spec-1');
        expect(instructions).toContain('Do not idle');
        expect(instructions).toContain('create_agent');
        expect(instructions).toContain('visible blocker');
    });
});
