import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentImage } from '@/api/types/genome';
import { fetchAgentImage } from '@/claude/utils/fetchGenome';
import { applyMetadataUpdates, buildBuiltinAgentImage, resolveMaterializedAgentImageForCreate } from './agents';

vi.mock('@/claude/utils/fetchGenome', () => ({
    fetchAgentImage: vi.fn(),
}));

beforeEach(() => {
    vi.clearAllMocks();
});

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

    it('gives implementation-heavy builtin workers a retire handoff policy', () => {
        const result = buildBuiltinAgentImage({
            roleId: 'implementer',
            displayName: 'Implementer Agent',
            runtime: 'codex',
            teamId: 'team-123',
        });

        expect(result.agentImage.behavior?.onRetire).toBe('write-handoff');
    });
});

describe('resolveMaterializedAgentImageForCreate', () => {
    it('uses the builtin image when no published spec is resolved', async () => {
        const builtinAgentImage = { name: 'Builtin Builder', runtimeType: 'claude' } as AgentImage;

        await expect(resolveMaterializedAgentImageForCreate({
            builtinAgentImage,
            specId: null,
            authToken: 'token-123',
        })).resolves.toBe(builtinAgentImage);
        expect(fetchAgentImage).not.toHaveBeenCalled();
    });

    it('requires an auth token when materializing a published agent image', async () => {
        await expect(resolveMaterializedAgentImageForCreate({
            builtinAgentImage: { name: 'Builtin Builder' } as AgentImage,
            specId: 'cm-spec-1',
            authToken: null,
        })).rejects.toThrow('missing auth token');
        expect(fetchAgentImage).not.toHaveBeenCalled();
    });

    it('loads the published agent image instead of silently falling back', async () => {
        const publishedAgentImage = { name: 'Published Builder', runtimeType: 'claude' } as AgentImage;
        vi.mocked(fetchAgentImage).mockResolvedValue(publishedAgentImage);

        await expect(resolveMaterializedAgentImageForCreate({
            builtinAgentImage: { name: 'Builtin Builder' } as AgentImage,
            specId: 'cm-spec-1',
            authToken: 'token-123',
        })).resolves.toBe(publishedAgentImage);

        expect(fetchAgentImage).toHaveBeenCalledWith('token-123', 'cm-spec-1');
    });

    it('fails hard when the resolved published agent image is missing', async () => {
        vi.mocked(fetchAgentImage).mockResolvedValue(null);

        await expect(resolveMaterializedAgentImageForCreate({
            builtinAgentImage: { name: 'Builtin Builder' } as AgentImage,
            specId: 'cm-spec-404',
            authToken: 'token-123',
        })).rejects.toThrow('was not found in genome-hub');
    });
});
