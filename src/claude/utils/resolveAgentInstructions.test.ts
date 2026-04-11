import { describe, expect, it } from 'vitest';
import type { AgentImage } from '@/api/types/genome';
import { resolveAgentInstructions } from './resolveAgentInstructions';

describe('resolveAgentInstructions', () => {
    it('uses the genome system prompt when present', () => {
        const agentImage = {
            systemPrompt: 'Hello {{AHA_AGENT_ROLE}} in {{AHA_TEAM_ID}}',
            systemPromptSuffix: 'Follow the roster.',
        } as AgentImage;

        const result = resolveAgentInstructions({
            agentImage,
            agentImageId: '@official/org-manager',
            role: 'org-manager',
            promptVars: {
                AHA_AGENT_ROLE: 'org-manager',
                AHA_TEAM_ID: 'team-123',
            },
        });

        expect(result.source).toBe('genome');
        expect(result.instructions).toContain('Hello org-manager in team-123');
        expect(result.instructions).toContain('Follow the roster.');
    });

    it('falls back to legacy genome fields when systemPrompt is missing', () => {
        const agentImage = {
            description: 'Staff and route the team.',
            responsibilities: ['Spawn agents', 'Keep the roster healthy'],
            protocol: ['Inspect the current team before adding seats'],
            systemPromptSuffix: 'Do not duplicate roles.',
        } as AgentImage;

        const result = resolveAgentInstructions({
            agentImage,
            agentImageId: '@official/org-manager',
            role: 'org-manager',
            promptVars: {},
        });

        expect(result.source).toBe('legacy-genome-fallback');
        expect(result.instructions).toContain('role: org-manager');
        expect(result.instructions).toContain('Staff and route the team.');
        expect(result.instructions).toContain('Spawn agents');
        expect(result.instructions).toContain('Inspect the current team before adding seats');
        expect(result.instructions).toContain('Do not duplicate roles.');
    });

    it('uses the ad-hoc fallback when no genome is loaded', () => {
        const result = resolveAgentInstructions({
            role: 'builder',
            promptVars: {},
        });

        expect(result.source).toBe('ad-hoc-fallback');
        expect(result.instructions).toContain('role: builder');
        expect(result.instructions).toContain('get_team_info');
        expect(result.instructions).toContain('list_tasks');
    });
});
