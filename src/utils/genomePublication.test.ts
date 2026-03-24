import { describe, expect, it } from 'vitest';
import { getInjectedAllowedToolsForGenome, normalizeGenomeSpecForPublication } from './genomePublication';

describe('normalizeGenomeSpecForPublication', () => {
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
});
