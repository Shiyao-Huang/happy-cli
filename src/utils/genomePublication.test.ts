import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { getInjectedAllowedToolsForAgentImage, normalizeAgentImageForPublication } from './genomePublication';

describe('normalizeAgentImageForPublication', () => {
    it('projects canonical agent.json authoring into a legacy-compatible AgentImage view', () => {
        const result = normalizeAgentImageForPublication({
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
            'get_self_view',
            'get_effective_permissions',
            'list_visible_tools',
            'explain_tool_access',
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
        const result = normalizeAgentImageForPublication({
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

    it('injects core tools, normalizes dangerous fields, and preserves hooks for non-official genomes', () => {
        const hooks = { preToolUse: [{ matcher: 'Bash', command: 'echo hello' }] };
        const result = normalizeAgentImageForPublication({
            namespace: '@public',
            specJson: JSON.stringify({
                allowedTools: ['Read', 'list_tasks'],
                hooks,
                executionPlane: 'bypass',
                accessLevel: 'full-access',
            }),
        });

        expect(result.spec.allowedTools).toEqual(expect.arrayContaining([
            'Read',
            'list_tasks',
            'send_team_message',
            'request_help',
            'get_self_view',
            'get_effective_permissions',
            'list_visible_tools',
            'explain_tool_access',
        ]));
        // hooks are kernel fields (AgentKernel) and must travel with the genome
        expect(result.spec.hooks).toEqual(hooks);
        expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('hooks')]));
        expect(result.spec.executionPlane).toBe('mainline');
        expect(result.spec.accessLevel).toBeUndefined();
    });

    it('migrates legacy tools[] into allowedTools and removes seedContext', () => {
        const result = normalizeAgentImageForPublication({
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
            'get_self_view',
            'get_effective_permissions',
            'list_visible_tools',
            'explain_tool_access',
        ]));
        expect((result.spec as any).tools).toBeUndefined();
        expect((result.spec as any).seedContext).toBeUndefined();
        expect(result.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('Legacy tools[] migrated'),
            expect.stringContaining('seedContext is deprecated'),
        ]));
    });

    it('injects create_agent tooling for spawn-capable genomes with explicit allowlists', () => {
        const result = normalizeAgentImageForPublication({
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
            'get_self_view',
            'get_effective_permissions',
            'list_visible_tools',
            'explain_tool_access',
            'create_agent',
            'list_available_agents',
            'list_team_agents',
            'get_team_config',
        ]));
    });

    it('supports runtime spawn-tool injection when role fallback allows spawning', () => {
        expect(getInjectedAllowedToolsForAgentImage(undefined, { spawnCapable: true })).toEqual(
            expect.arrayContaining([
                'get_self_view',
                'get_effective_permissions',
                'list_visible_tools',
                'explain_tool_access',
                'create_agent',
                'list_available_agents',
                'list_team_agents',
                'get_team_config',
            ]),
        );
    });

    it('preserves files from canonical agent.json through normalization', () => {
        const files = {
            '.claude/commands/foo/SKILL.md': '# Foo skill\nDo the foo thing.',
            '.aha-agent/mcp-servers/custom.json': '{"command":"node","args":["server.js"]}',
        };
        const result = normalizeAgentImageForPublication({
            namespace: '@public',
            specJson: JSON.stringify({
                kind: 'aha.agent.v1',
                name: 'my-agent',
                runtime: 'claude',
                files,
            }),
        });

        expect(result.spec.files).toEqual(files);
    });

    it('preserves workspace from canonical agent.json through normalization', () => {
        const result = normalizeAgentImageForPublication({
            namespace: '@public',
            specJson: JSON.stringify({
                kind: 'aha.agent.v1',
                name: 'my-agent',
                runtime: 'claude',
                workspace: { defaultMode: 'isolated', allowedModes: ['isolated'] },
            }),
        });

        expect(result.spec.workspace).toEqual({ defaultMode: 'isolated', allowedModes: ['isolated'] });
    });

    it('drops empty mutation notes instead of serializing null', () => {
        const result = normalizeAgentImageForPublication({
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

    it('auto-inlines skill content from runtime-lib into files when skill file exists', () => {
        const libRoot = mkdtempSync(join(tmpdir(), 'aha-test-'));
        try {
            const skillDir = join(libRoot, 'skills', 'context-mirror');
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(join(skillDir, 'SKILL.md'), '# Context Mirror\nDo the mirror thing.');

            const result = normalizeAgentImageForPublication({
                namespace: '@public',
                runtimeLibRoot: libRoot,
                specJson: JSON.stringify({
                    allowedTools: ['Read'],
                    skills: ['context-mirror'],
                }),
            });

            expect(result.spec.files).toEqual({
                '.claude/commands/context-mirror/SKILL.md': '# Context Mirror\nDo the mirror thing.',
            });
            expect(result.warnings).not.toEqual(expect.arrayContaining([expect.stringContaining('context-mirror')]));
        } finally {
            rmSync(libRoot, { recursive: true, force: true });
        }
    });

    it('emits a warning and omits the file when skill is not found in runtime-lib', () => {
        const libRoot = mkdtempSync(join(tmpdir(), 'aha-test-'));
        try {
            const result = normalizeAgentImageForPublication({
                namespace: '@public',
                runtimeLibRoot: libRoot,
                specJson: JSON.stringify({
                    allowedTools: ['Read'],
                    skills: ['nonexistent-skill'],
                }),
            });

            expect(result.spec.files).toBeUndefined();
            expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('nonexistent-skill')]));
        } finally {
            rmSync(libRoot, { recursive: true, force: true });
        }
    });

    it('does not overwrite user-provided inline skill content in files', () => {
        const libRoot = mkdtempSync(join(tmpdir(), 'aha-test-'));
        try {
            const skillDir = join(libRoot, 'skills', 'commit');
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(join(skillDir, 'SKILL.md'), '# Commit from runtime-lib');

            const result = normalizeAgentImageForPublication({
                namespace: '@public',
                runtimeLibRoot: libRoot,
                specJson: JSON.stringify({
                    allowedTools: ['Read'],
                    skills: ['commit'],
                    files: {
                        '.claude/commands/commit/SKILL.md': '# Custom commit skill',
                    },
                }),
            });

            expect(result.spec.files?.['.claude/commands/commit/SKILL.md']).toBe('# Custom commit skill');
        } finally {
            rmSync(libRoot, { recursive: true, force: true });
        }
    });

    it('auto-inlines skill content from user skill roots when runtime-lib does not contain it', () => {
        const previousSkillRoots = process.env.AHA_SKILL_ROOTS;
        const libRoot = mkdtempSync(join(tmpdir(), 'aha-test-lib-'));
        const userSkillRoot = mkdtempSync(join(tmpdir(), 'aha-test-user-skills-'));

        try {
            const skillDir = join(userSkillRoot, 'commit');
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(join(skillDir, 'SKILL.md'), '# Commit from user skill root');
            process.env.AHA_SKILL_ROOTS = userSkillRoot;

            const result = normalizeAgentImageForPublication({
                namespace: '@public',
                runtimeLibRoot: libRoot,
                specJson: JSON.stringify({
                    allowedTools: ['Read'],
                    skills: ['commit'],
                }),
            });

            expect(result.spec.files).toEqual({
                '.claude/commands/commit/SKILL.md': '# Commit from user skill root',
            });
        } finally {
            if (previousSkillRoots === undefined) {
                delete process.env.AHA_SKILL_ROOTS;
            } else {
                process.env.AHA_SKILL_ROOTS = previousSkillRoots;
            }
            rmSync(libRoot, { recursive: true, force: true });
            rmSync(userSkillRoot, { recursive: true, force: true });
        }
    });
});
