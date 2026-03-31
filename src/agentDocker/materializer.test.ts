import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { describe, expect, it } from 'vitest';

import {
    buildAgentWorkspacePlan,
    buildAgentWorkspacePlanFromAgentImage,
    ensureRuntimeLibStructure,
    materializeAgentWorkspace,
    withDefaultAgentSkills,
} from './materializer';

describe('buildAgentWorkspacePlan', () => {
    it('builds shared workspace plan with per-agent runtime dirs', () => {
        const plan = buildAgentWorkspacePlan({
            agentId: 'agent-1',
            repoRoot: '/repo/project',
            runtime: 'claude',
            workspaceMode: 'shared',
            config: {
                kind: 'aha.agent.v1',
                name: 'Supervisor',
                runtime: 'claude',
                tools: {
                    skills: ['review', 'score'],
                },
                workspace: {
                    defaultMode: 'shared',
                    allowedModes: ['shared', 'isolated'],
                },
            },
        });

        expect(plan.workspaceMode).toBe('shared');
        expect(plan.effectiveCwd).toBe('/repo/project');
        expect(plan.commandsDir).toContain('/runtime/agent-1/workspace/.claude/commands');
        expect(plan.actions.some((a) => a.kind === 'attach-repo')).toBe(true);
        expect(plan.actions.filter((a) => a.kind === 'link-skill' && a.required)).toHaveLength(2);
    });

    it('falls back when requested workspace mode is not allowed', () => {
        const plan = buildAgentWorkspacePlan({
            agentId: 'agent-2',
            repoRoot: '/repo/project',
            runtime: 'claude',
            workspaceMode: 'shared',
            config: {
                kind: 'aha.agent.v1',
                name: 'Mutator',
                runtime: 'claude',
                workspace: {
                    defaultMode: 'isolated',
                    allowedModes: ['isolated'],
                },
            },
        });

        expect(plan.workspaceMode).toBe('isolated');
        expect(plan.autoUpgradedToIsolated).toBe(true);
        expect(plan.effectiveCwd).toContain('/runtime/agent-2/workspace/project');
        expect(plan.warnings[0]).toContain('falling back');
    });

    it('filters skills via launch overrides without mutating source config', () => {
        const config = {
            kind: 'aha.agent.v1' as const,
            name: 'Researcher',
            runtime: 'claude' as const,
            tools: {
                skills: ['review', 'search', 'summarize'],
            },
        };

        const plan = buildAgentWorkspacePlan({
            agentId: 'agent-3',
            repoRoot: '/repo/project',
            runtime: 'claude',
            config,
            launchOverrides: {
                allowedSkills: ['search'],
            },
        });

        expect(plan.actions.filter((a) => a.kind === 'link-skill' && a.required)).toHaveLength(1);
        expect(plan.actions.find((a) => a.kind === 'link-skill' && a.required)?.target).toContain('/commands/search');
        expect(config.tools.skills).toEqual(['review', 'search', 'summarize']);
    });

    it('materializes isolated workspace with settings, env, mcp and linked skills', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');
        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(join(runtimeLibRoot, 'skills', 'review'), { recursive: true });
        writeFileSync(join(runtimeLibRoot, 'skills', 'review', 'SKILL.md'), '# review', 'utf-8');
        writeFileSync(join(repoRoot, 'README.md'), 'source repo', 'utf-8');

        const plan = materializeAgentWorkspace({
            agentId: 'agent-4',
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'isolated',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'Reviewer',
                runtime: 'claude',
                tools: {
                    skills: ['review'],
                    mcpServers: ['aha'],
                },
                hooks: {
                    postToolUse: [
                        { matcher: 'Read', command: 'echo reviewed' },
                    ],
                },
                env: {
                    required: ['AHA_ROOM_ID'],
                },
            },
            launchOverrides: {
                env: {
                    AHA_ROOM_ID: 'team-1',
                },
            },
        });

        expect(plan.workspaceMode).toBe('isolated');
        expect(realpathSync(plan.projectViewPath)).not.toBe(realpathSync(repoRoot));
        expect(readFileSync(join(plan.projectViewPath, 'README.md'), 'utf-8')).toBe('source repo');
        writeFileSync(join(plan.projectViewPath, 'README.md'), 'isolated change', 'utf-8');
        expect(readFileSync(join(repoRoot, 'README.md'), 'utf-8')).toBe('source repo');

        const settings = JSON.parse(readFileSync(plan.settingsPath, 'utf-8'));
        expect(settings.hooks.PostToolUse).toHaveLength(1);

        const envJson = JSON.parse(readFileSync(plan.envFilePath, 'utf-8'));
        expect(envJson.required).toEqual(['AHA_ROOM_ID']);
        expect(envJson.launchOverrides.AHA_ROOM_ID).toBe('team-1');
        expect(envJson.values).toEqual({ AHA_ROOM_ID: 'team-1' });

        const mcpJson = JSON.parse(readFileSync(plan.mcpConfigPath, 'utf-8'));
        expect(mcpJson.mcpServers).toEqual(['aha']);

        expect(realpathSync(join(plan.commandsDir, 'review'))).toBe(
            realpathSync(join(runtimeLibRoot, 'skills', 'review')),
        );
        expect(lstatSync(join(plan.commandsDir, 'review')).isSymbolicLink()).toBe(true);
    });

    it('bridges AgentImage into a materialized workspace plan with env/hooks/mcp mapping', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-genome-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');
        const repoConfigRoot = join(root, '.aha-config');
        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(join(runtimeLibRoot, 'skills', 'review'), { recursive: true });
        mkdirSync(join(runtimeLibRoot, 'skills', 'ship'), { recursive: true });
        writeFileSync(join(runtimeLibRoot, 'skills', 'review', 'SKILL.md'), '# review', 'utf-8');
        writeFileSync(join(runtimeLibRoot, 'skills', 'ship', 'SKILL.md'), '# ship', 'utf-8');
        writeFileSync(join(repoRoot, 'index.ts'), 'export const hello = "world";\n', 'utf-8');

        const plan = buildAgentWorkspacePlanFromAgentImage({
            displayName: 'Genome Reviewer',
            namespace: '@test',
            version: 2,
            runtimeType: 'codex',
            mcpServers: ['aha'],
            skills: ['review', 'ship'],
            hooks: {
                preToolUse: [{ matcher: 'Read', command: 'echo pre' }],
                stop: [{ command: 'echo stop' }],
            },
            env: {
                requiredEnv: ['AHA_ROOM_ID'],
                optionalEnv: ['AHA_SESSION_ID'],
            },
            provenance: {
                origin: 'forked',
                parentId: 'genome-parent-1',
                mutationNote: 'Added codex runtime',
            },
            evalCriteria: [
                'Respond with a complete review summary',
                'Keep tool usage minimal',
            ],
        } as any, {
            agentId: `genome-agent-${Date.now()}`,
            repoRoot,
            runtimeLibRoot,
            repoConfigRoot,
            specId: '@test/genome-reviewer:2',
            workspaceMode: 'isolated',
            launchOverrides: {
                env: {
                    AHA_ROOM_ID: 'team-2',
                },
                allowedSkills: ['review'],
            },
        });

        expect(plan.workspaceMode).toBe('isolated');
        expect(plan.runtimeLibRoot).toBe(runtimeLibRoot);
        expect(plan.repoConfigRoot).toBe(repoConfigRoot);
        expect(realpathSync(plan.projectViewPath)).not.toBe(realpathSync(repoRoot));
        expect(readFileSync(join(plan.projectViewPath, 'index.ts'), 'utf-8')).toContain('hello');

        const settings = JSON.parse(readFileSync(plan.settingsPath, 'utf-8'));
        expect(settings.hooks.PreToolUse).toHaveLength(1);
        expect(settings.hooks.Stop).toHaveLength(1);

        const envJson = JSON.parse(readFileSync(plan.envFilePath, 'utf-8'));
        expect(envJson.required).toEqual(['AHA_ROOM_ID']);
        expect(envJson.optional).toEqual(['AHA_SESSION_ID']);
        expect(envJson.launchOverrides).toEqual({ AHA_ROOM_ID: 'team-2' });
        expect(envJson.values).toEqual({ AHA_ROOM_ID: 'team-2' });

        const mcpJson = JSON.parse(readFileSync(plan.mcpConfigPath, 'utf-8'));
        expect(mcpJson.mcpServers).toEqual(['aha']);

        const genomeSpecJson = JSON.parse(readFileSync(plan.genomeSpecPath, 'utf-8'));
        expect(genomeSpecJson.namespace).toBe('@test');
        expect(genomeSpecJson.contextInjections.some((entry: any) => entry.content.includes('__genome_ref__'))).toBe(true);
        expect(genomeSpecJson.contextInjections.some((entry: any) => entry.content.includes('@test/genome-reviewer:2'))).toBe(true);

        const lineageJson = JSON.parse(readFileSync(plan.genomeLineagePath, 'utf-8'));
        expect(lineageJson).toEqual({
            specId: '@test/genome-reviewer:2',
            namespace: '@test',
            version: 2,
            origin: 'forked',
            parentId: 'genome-parent-1',
            mutationNote: 'Added codex runtime',
        });

        const evalCriteria = readFileSync(plan.genomeEvalCriteriaPath, 'utf-8');
        expect(evalCriteria).toContain('Respond with a complete review summary');
        expect(evalCriteria).toContain('Keep tool usage minimal');

        expect(realpathSync(join(plan.commandsDir, 'review'))).toBe(
            realpathSync(join(runtimeLibRoot, 'skills', 'review')),
        );
        expect(existsSync(join(plan.commandsDir, 'ship'))).toBe(false);
    });

    it('uses fallback shared mode defaults when AgentImage does not declare extras', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-genome-default-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');
        const defaultSkillDir = join(runtimeLibRoot, 'skills', 'context-mirror');
        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(defaultSkillDir, { recursive: true });
        writeFileSync(join(defaultSkillDir, 'SKILL.md'), '# context-mirror', 'utf-8');

        const plan = buildAgentWorkspacePlanFromAgentImage({
            baseRoleId: 'builder',
        }, {
            agentId: `default-agent-${Date.now()}`,
            repoRoot,
            runtimeLibRoot,
        });

        expect(plan.workspaceMode).toBe('shared');
        expect(plan.effectiveCwd).toBe(repoRoot);
        expect(plan.actions.some((action) => action.kind === 'attach-repo')).toBe(true);
        expect(plan.actions.some((action) => action.kind === 'create-worktree')).toBe(false);
        expect(readFileSync(plan.genomeEvalCriteriaPath, 'utf-8')).toContain('No explicit evalCriteria declared');
    });

    it('creates the shared runtime-lib directory structure', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-runtime-lib-'));
        const runtimeLibRoot = join(root, 'runtime-lib');

        const layout = ensureRuntimeLibStructure(runtimeLibRoot);

        expect(existsSync(layout.root)).toBe(true);
        expect(existsSync(layout.skillsDir)).toBe(true);
        expect(existsSync(layout.mcpDir)).toBe(true);
        expect(existsSync(layout.promptsDir)).toBe(true);
        expect(existsSync(layout.hooksDir)).toBe(true);
        expect(existsSync(layout.toolsDir)).toBe(true);
    });

    it('adds context-mirror to the default skill set exactly once', () => {
        expect(withDefaultAgentSkills()).toEqual(['context-mirror']);
        expect(withDefaultAgentSkills(['review', 'context-mirror'])).toEqual(['review', 'context-mirror']);
    });

    it('copies a skill into commandsDir when materializationPolicy requests copy', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-copy-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');
        const skillDir = join(runtimeLibRoot, 'skills', 'review');

        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), '# review', 'utf-8');

        const plan = materializeAgentWorkspace({
            agentId: `copy-skill-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'CopySkillTest',
                runtime: 'claude',
                build: {
                    materializationPolicy: {
                        skills: {
                            review: 'copy',
                        },
                    },
                },
                tools: {
                    skills: ['review'],
                },
            },
        });

        const target = join(plan.commandsDir, 'review');
        expect(existsSync(target)).toBe(true);
        expect(lstatSync(target).isSymbolicLink()).toBe(false);
        expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toBe('# review');
    });

    it('keeps inline skill files authoritative over runtime-lib skill sources', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-inline-skill-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');
        const skillDir = join(runtimeLibRoot, 'skills', 'review');

        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), '# review from runtime-lib', 'utf-8');

        const plan = materializeAgentWorkspace({
            agentId: `inline-skill-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'InlineSkillTest',
                runtime: 'claude',
                tools: {
                    skills: ['review'],
                },
                files: {
                    '.claude/commands/review/SKILL.md': '# review from inline image',
                },
            },
        });

        const target = join(plan.commandsDir, 'review');
        expect(lstatSync(target).isSymbolicLink()).toBe(false);
        expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toBe('# review from inline image');
    });

    it('falls back to repo-local skills when runtime-lib does not contain the skill', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-repo-skill-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');
        const repoSkillDir = join(repoRoot, 'skills', 'context-mirror');

        mkdirSync(repoSkillDir, { recursive: true });
        writeFileSync(join(repoSkillDir, 'SKILL.md'), '# context-mirror', 'utf-8');

        const plan = materializeAgentWorkspace({
            agentId: `repo-skill-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'RepoSkillTest',
                runtime: 'claude',
                tools: {
                    skills: ['context-mirror'],
                },
            },
        });

        expect(readFileSync(join(plan.commandsDir, 'context-mirror', 'SKILL.md'), 'utf-8')).toBe('# context-mirror');
    });

    it('unions user-installed skills into commandsDir as additive runtime skills', () => {
        const previousSkillRoots = process.env.AHA_SKILL_ROOTS;
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-global-skill-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');
        const runtimeSkillDir = join(runtimeLibRoot, 'skills', 'review');
        const userSkillRoot = join(root, 'user-skills');
        const userSkillDir = join(userSkillRoot, 'user-extra');

        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(runtimeSkillDir, { recursive: true });
        mkdirSync(userSkillDir, { recursive: true });
        writeFileSync(join(runtimeSkillDir, 'SKILL.md'), '# review', 'utf-8');
        writeFileSync(join(userSkillDir, 'SKILL.md'), '# user-extra', 'utf-8');

        process.env.AHA_SKILL_ROOTS = userSkillRoot;

        try {
            const plan = materializeAgentWorkspace({
                agentId: `global-skill-${Date.now()}`,
                repoRoot,
                runtime: 'claude',
                workspaceMode: 'shared',
                runtimeLibRoot,
                config: {
                    kind: 'aha.agent.v1',
                    name: 'GlobalSkillTest',
                    runtime: 'claude',
                    tools: {
                        skills: ['review'],
                    },
                },
            });

            expect(readFileSync(join(plan.commandsDir, 'review', 'SKILL.md'), 'utf-8')).toBe('# review');
            expect(readFileSync(join(plan.commandsDir, 'user-extra', 'SKILL.md'), 'utf-8')).toBe('# user-extra');
        } finally {
            if (previousSkillRoots === undefined) {
                delete process.env.AHA_SKILL_ROOTS;
            } else {
                process.env.AHA_SKILL_ROOTS = previousSkillRoots;
            }
        }
    });

    it('replaces dangling skill symlinks when rematerializing the same agent workspace', () => {
        const rootA = mkdtempSync(join(tmpdir(), 'aha-materializer-dangling-a-'));
        const rootB = mkdtempSync(join(tmpdir(), 'aha-materializer-dangling-b-'));
        const repoRoot = join(rootA, 'repo');
        const runtimeLibRootA = join(rootA, 'runtime-lib');
        const runtimeLibRootB = join(rootB, 'runtime-lib');
        const skillDirA = join(runtimeLibRootA, 'skills', 'review');
        const skillDirB = join(runtimeLibRootB, 'skills', 'review');
        const agentId = `dangling-symlink-${Date.now()}`;

        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(skillDirA, { recursive: true });
        mkdirSync(skillDirB, { recursive: true });
        writeFileSync(join(skillDirA, 'SKILL.md'), '# review A', 'utf-8');
        writeFileSync(join(skillDirB, 'SKILL.md'), '# review B', 'utf-8');

        const firstPlan = materializeAgentWorkspace({
            agentId,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot: runtimeLibRootA,
            config: {
                kind: 'aha.agent.v1',
                name: 'ReviewA',
                runtime: 'claude',
                tools: { skills: ['review'] },
            },
        });
        const target = join(firstPlan.commandsDir, 'review');
        expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toBe('# review A');

        rmSync(runtimeLibRootA, { recursive: true, force: true });

        const secondPlan = materializeAgentWorkspace({
            agentId,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot: runtimeLibRootB,
            config: {
                kind: 'aha.agent.v1',
                name: 'ReviewB',
                runtime: 'claude',
                tools: { skills: ['review'] },
            },
        });

        expect(readFileSync(join(secondPlan.commandsDir, 'review', 'SKILL.md'), 'utf-8')).toBe('# review B');
    });

    it('throws when a declared skill has no inline file and no runtime-lib source', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-missing-skill-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');

        mkdirSync(repoRoot, { recursive: true });

        expect(() => materializeAgentWorkspace({
            agentId: `missing-skill-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'MissingSkillTest',
                runtime: 'claude',
                tools: {
                    skills: ['context-mirror'],
                },
            },
        })).toThrow(
            'Skill "context-mirror" declared in skills[] but content is missing.',
        );
    });

    it('succeeds with inline skill files even when runtime-lib does not contain the skill', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-materializer-inline-skill-'));
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');

        mkdirSync(repoRoot, { recursive: true });

        const plan = materializeAgentWorkspace({
            agentId: `inline-skill-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'InlineSkillTest',
                runtime: 'claude',
                tools: {
                    skills: ['context-mirror'],
                },
                files: {
                    '.claude/commands/context-mirror/SKILL.md': '# inline context-mirror',
                },
            },
        });

        expect(readFileSync(join(plan.commandsDir, 'context-mirror', 'SKILL.md'), 'utf-8')).toBe('# inline context-mirror');
    });
});
