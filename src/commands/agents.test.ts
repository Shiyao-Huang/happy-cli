import { describe, expect, it } from 'vitest';

import { applyMetadataUpdates, buildBuiltinAgentImage } from './agents';

describe('applyMetadataUpdates model validation', () => {
    it('accepts recognized Claude model overrides', () => {
        expect(applyMetadataUpdates({}, {
            model: 'claude-opus-4-6',
            fallbackModel: 'claude-haiku-4-6',
        })).toMatchObject({
            modelOverride: 'claude-opus-4-6',
            fallbackModelOverride: 'claude-haiku-4-6',
        });
    });

    it('rejects unknown model overrides', () => {
        expect(() => applyMetadataUpdates({}, {
            model: 'definitely-not-a-real-model',
        })).toThrow('Unknown model ID');
    });
});

describe('buildBuiltinAgentImage', () => {
    it('projects create-agent defaults into hub-compatible AgentImage fields', () => {
        const result = buildBuiltinAgentImage({
            roleId: 'builder',
            displayName: 'Builder One',
            runtime: 'claude',
            teamId: 'team-123',
        });

        expect(result.promptSuffix).toContain('## Team Context');
        expect(result.agentImage.displayName).toBe('Builder One');
        expect(result.agentImage.baseRoleId).toBe('builder');
        expect(result.agentImage.runtimeType).toBe('claude');
        expect(result.agentImage.teamRole).toBe('builder');
        expect(result.agentImage.skills).toContain('context-mirror');
        expect(result.agentImage.mcpServers).toContain('aha');
        expect(result.agentImage.protocol?.some((entry) => entry.includes('Kanban board'))).toBe(true);
        expect(result.agentImage.capabilities).toEqual(
            expect.arrayContaining(['kanban-task-lifecycle', 'team-collaboration']),
        );
        expect((result.agentImage as Record<string, unknown>).tools).toEqual(
            expect.objectContaining({
                mcpServers: ['aha'],
                skills: expect.arrayContaining(['context-mirror']),
            }),
        );
    });

    it('adds coordinator authorities for master roles', () => {
        const result = buildBuiltinAgentImage({
            roleId: 'master',
            displayName: 'Master Agent',
            runtime: 'claude',
            teamId: 'team-123',
        });

        expect(result.agentImage.authorities).toEqual(
            expect.arrayContaining(['task.create', 'agent.spawn']),
        );
    });
});
