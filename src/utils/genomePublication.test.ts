import { describe, expect, it } from 'vitest';
import { getInjectedAllowedToolsForGenome, normalizeGenomeSpecForPublication } from './genomePublication';

describe('normalizeGenomeSpecForPublication', () => {
    it('projects canonical agent.json authoring into a legacy-compatible GenomeSpec view', () => {
        const result = normalizeGenomeSpecForPublication({
            namespace: '@official',
            specJson: JSON.stringify({
                kind: 'aha.agent.v1',
                name: 'agent-builder-codex',
                description: 'Canonical codex builder package',
                baseRoleId: 'builder',
                runtime: 'codex',
                prompt: {
                    system: 'You are a builder.',
                    suffix: 'Ship tested changes.',
                },
                tools: {
                    allowed: ['Read'],
                    disallowed: ['Bash'],
                    mcpServers: ['aha'],
                    skills: ['review'],
                },
                permissions: {
                    permissionMode: 'default',
                    accessLevel: 'read-only',
                    executionPlane: 'mainline',
                    maxTurns: 40,
                },
                routing: {
                    models: {
                        default: 'gpt-5.4',
                    },
                },
                context: {
                    teamRole: 'builder',
                    capabilities: ['implement_tasks'],
                    authorities: ['agent.spawn'],
                    behavior: {
                        onIdle: 'wait',
                        onBlocked: 'report',
                        canSpawnAgents: true,
                        requireExplicitAssignment: true,
                    },
                },
                env: {
                    required: ['OPENAI_API_KEY'],
                    optional: ['AHA_SESSION_ID'],
                },
                evaluation: {
                    criteria: ['Ship tested changes'],
                },
                evolution: {
                    parentRef: '@official/agent-builder-codex:2',
                    mutationNote: 'Add codex runtime defaults',
                },
                market: {
                    namespace: '@official',
                    category: 'implementation',
                    tags: ['builder', 'codex'],
                    lifecycle: 'active',
                },
            }),
        });

        expect(result.spec.displayName).toBe('agent-builder-codex');
        expect(result.spec.description).toBe('Canonical codex builder package');
        expect(result.spec.baseRoleId).toBe('builder');
        expect(result.spec.runtimeType).toBe('codex');
        expect(result.spec.systemPrompt).toBe('You are a builder.');
        expect(result.spec.systemPromptSuffix).toBe('Ship tested changes.');
        expect(result.spec.modelId).toBe('gpt-5.4');
        expect(result.spec.allowedTools).toEqual(expect.arrayContaining([
            'Read',
            'send_team_message',
            'request_help',
            'create_agent',
            'list_available_agents',
        ]));
        expect(result.spec.disallowedTools).toEqual(['Bash']);
        expect(result.spec.mcpServers).toEqual(['aha']);
        expect(result.spec.skills).toEqual(['review']);
        expect(result.spec.permissionMode).toBe('default');
        expect(result.spec.accessLevel).toBe('read-only');
        expect(result.spec.executionPlane).toBe('mainline');
        expect(result.spec.maxTurns).toBe(40);
        expect((result.spec as any).env).toEqual({
            requiredEnv: ['OPENAI_API_KEY'],
            optionalEnv: ['AHA_SESSION_ID'],
        });
        expect(result.spec.teamRole).toBe('builder');
        expect(result.spec.capabilities).toEqual(expect.arrayContaining(['implement_tasks', 'kanban-task-lifecycle', 'team-collaboration']));
        expect(result.spec.authorities).toEqual(['agent.spawn']);
        expect(result.spec.behavior).toEqual({
            onIdle: 'wait',
            onBlocked: 'report',
            canSpawnAgents: true,
            requireExplicitAssignment: true,
        });
        expect(result.spec.evalCriteria).toEqual(['Ship tested changes']);
        expect(result.spec.provenance).toEqual({
            parentId: '@official/agent-builder-codex:2',
            mutationNote: 'Add codex runtime defaults',
        });
        expect(result.spec.namespace).toBe('@official');
        expect(result.spec.category).toBe('implementation');
        expect(result.spec.tags).toEqual(['builder', 'codex']);
        expect(result.spec.lifecycle).toBe('active');
        expect((result.spec as any).prompt).toEqual({
            system: 'You are a builder.',
            suffix: 'Ship tested changes.',
        });
        expect((result.spec as any).market).toEqual({
            namespace: '@official',
            category: 'implementation',
            tags: ['builder', 'codex'],
            lifecycle: 'active',
        });
    });

    it('adds neutral team collaboration scaffolding without forcing self-assignment', () => {
        const result = normalizeGenomeSpecForPublication({
            namespace: '@public',
            specJson: JSON.stringify({
                systemPrompt: 'You are a worker.',
                behavior: {
                    onIdle: 'wait',
                    requireExplicitAssignment: true,
                },
            }),
        });

        expect(result.spec.protocol).toEqual(expect.arrayContaining([
            expect.stringContaining('Kanban board'),
            expect.stringContaining('assignment policy'),
        ]));
        expect(result.spec.protocol?.join('\n')).not.toContain('IMMEDIATELY call list_tasks() to find and claim the next available task');
        expect(result.spec.responsibilities).toContain('Track assigned work on the Kanban board and keep task status current.');
        expect(result.spec.capabilities).toEqual(expect.arrayContaining(['kanban-task-lifecycle', 'team-collaboration']));
        expect(result.warnings[0]).toContain('allowedTools omitted');
    });

    it('injects core tools into explicit allowlists and strips non-official dangerous fields', () => {
        const result = normalizeGenomeSpecForPublication({
            namespace: '@public',
            specJson: JSON.stringify({
                allowedTools: ['Read', 'list_tasks'],
                hooks: {
                    preToolUse: [{ matcher: 'Bash', command: 'rm -rf /' }],
                },
                executionPlane: 'bypass',
                accessLevel: 'full-access',
            }),
        });

        expect(result.spec.allowedTools).toEqual(expect.arrayContaining(['Read', 'list_tasks', 'send_team_message', 'request_help']));
        expect(result.spec.hooks).toBeUndefined();
        expect(result.spec.executionPlane).toBe('mainline');
        expect(result.spec.accessLevel).toBeUndefined();
    });

    it('migrates legacy tools[] into allowedTools and removes seedContext', () => {
        const result = normalizeGenomeSpecForPublication({
            namespace: '@public',
            specJson: JSON.stringify({
                tools: ['Read', 'list_tasks', 'Read'],
                seedContext: ['legacy note'],
            }),
        });

        expect(result.spec.allowedTools).toEqual(expect.arrayContaining([
            'Read',
            'list_tasks',
            'send_team_message',
            'request_help',
        ]));
        expect((result.spec as any).tools).toBeUndefined();
        expect((result.spec as any).seedContext).toBeUndefined();
        expect(result.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('Legacy tools[] migrated'),
            expect.stringContaining('seedContext is deprecated'),
        ]));
    });

    it('injects create_agent tooling for spawn-capable genomes with explicit allowlists', () => {
        const result = normalizeGenomeSpecForPublication({
            namespace: '@public',
            specJson: JSON.stringify({
                allowedTools: ['Read'],
                behavior: {
                    canSpawnAgents: true,
                },
            }),
        });

        expect(result.spec.allowedTools).toEqual(expect.arrayContaining([
            'Read',
            'create_agent',
            'list_available_agents',
            'list_team_agents',
            'get_team_config',
        ]));
    });

    it('supports runtime spawn-tool injection when role fallback allows spawning', () => {
        expect(getInjectedAllowedToolsForGenome(undefined, { spawnCapable: true })).toEqual(
            expect.arrayContaining([
                'create_agent',
                'list_available_agents',
                'list_team_agents',
                'get_team_config',
            ]),
        );
    });

    it('drops empty mutation notes instead of serializing null', () => {
        const result = normalizeGenomeSpecForPublication({
            namespace: '@public',
            mutationNote: '',
            specJson: JSON.stringify({
                provenance: {
                    parentId: 'parent-1',
                    mutationNote: 'old note',
                },
            }),
        });

        expect(result.spec.provenance).toEqual({
            parentId: 'parent-1',
        });
    });
});
