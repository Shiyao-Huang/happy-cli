/**
 * Layer 3: Agent Mechanism Verification Tests
 *
 * Validates that hooks and skills wired through materializeAgentWorkspace()
 * actually work at the mechanism level — no AI API key required.
 *
 * Layer 3a: PostToolUse hook command is written to settings.json and executes correctly.
 * Layer 3b: Skill symlink is created in commandsDir and its content is accessible.
 *
 * Usage:
 *   yarn vitest run src/agentDocker/__tests__/agentMechanismE2E.test.ts
 */
import { execSync } from 'child_process';
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { afterEach, describe, expect, it } from 'vitest';

import { materializeAgentWorkspace } from '../materializer';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const cleanupRoots: string[] = [];

afterEach(() => {
    while (cleanupRoots.length > 0) {
        const root = cleanupRoots.pop();
        if (root && existsSync(root)) {
            rmSync(root, { recursive: true, force: true });
        }
    }
});

function makeTempRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    cleanupRoots.push(root);
    return root;
}

// ── Layer 3a: Hook Execution Verification ─────────────────────────────────────

describe('Layer 3a: PostToolUse hook mechanism', () => {
    it('writes hook command to settings.json and executes it correctly', () => {
        const root = makeTempRoot('aha-hook-mech-');
        const repoRoot = join(root, 'repo');
        const hookVerifyFile = join(root, 'hook-verify.txt');
        mkdirSync(repoRoot, { recursive: true });

        const plan = materializeAgentWorkspace({
            agentId: `hook-mech-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            config: {
                kind: 'aha.agent.v1',
                name: 'HookMechTest',
                runtime: 'claude',
                hooks: {
                    postToolUse: [
                        {
                            matcher: 'Bash',
                            command: `echo "HOOK_FIRED" > "${hookVerifyFile}"`,
                        },
                    ],
                },
            },
        });

        // Verify settings.json was written with the hook entry
        expect(existsSync(plan.settingsPath)).toBe(true);
        const settings = JSON.parse(readFileSync(plan.settingsPath, 'utf-8')) as {
            hooks?: {
                PostToolUse?: Array<{
                    matcher: string;
                    hooks: Array<{ type: string; command: string }>;
                }>;
            };
        };
        expect(settings.hooks?.PostToolUse).toHaveLength(1);

        const hookEntry = settings.hooks!.PostToolUse![0];
        expect(hookEntry.matcher).toBe('Bash');
        expect(hookEntry.hooks).toHaveLength(1);
        expect(hookEntry.hooks[0].type).toBe('command');

        const hookCommand = hookEntry.hooks[0].command;
        expect(typeof hookCommand).toBe('string');
        expect(hookCommand.length).toBeGreaterThan(0);

        // Execute the hook command directly (simulates what Claude Code would do)
        expect(() => execSync(hookCommand, { stdio: 'pipe' })).not.toThrow();

        // Verify the hook actually ran and produced output
        expect(existsSync(hookVerifyFile)).toBe(true);
        const output = readFileSync(hookVerifyFile, 'utf-8').trim();
        expect(output).toBe('HOOK_FIRED');
    });

    it('stop hook is written to settings.json with wildcard matcher', () => {
        const root = makeTempRoot('aha-stop-hook-');
        const repoRoot = join(root, 'repo');
        mkdirSync(repoRoot, { recursive: true });

        const plan = materializeAgentWorkspace({
            agentId: `stop-hook-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            config: {
                kind: 'aha.agent.v1',
                name: 'StopHookTest',
                runtime: 'claude',
                hooks: {
                    stop: [{ command: 'echo "SESSION_ENDED"' }],
                },
            },
        });

        const settings = JSON.parse(readFileSync(plan.settingsPath, 'utf-8')) as {
            hooks?: {
                Stop?: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
            };
        };
        expect(settings.hooks?.Stop).toHaveLength(1);
        expect(settings.hooks!.Stop![0].matcher).toBe('*');
        expect(settings.hooks!.Stop![0].hooks[0].command).toBe('echo "SESSION_ENDED"');
    });

    it('multiple hooks of same type are all written to settings.json', () => {
        const root = makeTempRoot('aha-multi-hook-');
        const repoRoot = join(root, 'repo');
        mkdirSync(repoRoot, { recursive: true });

        const plan = materializeAgentWorkspace({
            agentId: `multi-hook-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            config: {
                kind: 'aha.agent.v1',
                name: 'MultiHookTest',
                runtime: 'claude',
                hooks: {
                    preToolUse: [
                        { matcher: 'Edit', command: 'echo pre-edit' },
                        { matcher: 'Bash', command: 'echo pre-bash' },
                    ],
                    postToolUse: [
                        { matcher: '*', command: 'echo post-all' },
                    ],
                },
            },
        });

        const settings = JSON.parse(readFileSync(plan.settingsPath, 'utf-8')) as {
            hooks?: {
                PreToolUse?: unknown[];
                PostToolUse?: unknown[];
            };
        };
        expect(settings.hooks?.PreToolUse).toHaveLength(2);
        expect(settings.hooks?.PostToolUse).toHaveLength(1);
    });
});

// ── Layer 3b: Skill Access Verification ───────────────────────────────────────

describe('Layer 3b: Skill symlink access mechanism', () => {
    it('skill symlink in commandsDir is readable after materialization', () => {
        const root = makeTempRoot('aha-skill-mech-');
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');

        mkdirSync(repoRoot, { recursive: true });

        // Create test-echo skill fixture inline
        const skillDir = join(runtimeLibRoot, 'skills', 'test-echo');
        mkdirSync(skillDir, { recursive: true });
        const skillContent = [
            '# test-echo Skill',
            '',
            'When the user says "echo <msg>", output exactly: `[ECHO] <msg>`',
            '',
            'This skill is used for automated E2E testing.',
        ].join('\n');
        writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8');

        const plan = materializeAgentWorkspace({
            agentId: `skill-mech-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'SkillMechTest',
                runtime: 'claude',
                tools: {
                    skills: ['test-echo'],
                },
            },
        });

        // Verify symlink exists in commandsDir
        const skillLink = join(plan.commandsDir, 'test-echo');
        expect(existsSync(skillLink)).toBe(true);

        // Verify SKILL.md is accessible through the symlink
        const skillMdPath = join(skillLink, 'SKILL.md');
        expect(existsSync(skillMdPath)).toBe(true);

        // Verify content is readable and correct
        const content = readFileSync(skillMdPath, 'utf-8');
        expect(content).toContain('[ECHO]');
        expect(content).toContain('test-echo');
    });

    it('excluded skills are NOT present in commandsDir (allowedSkills filter)', () => {
        const root = makeTempRoot('aha-skill-filter-');
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');

        mkdirSync(repoRoot, { recursive: true });
        // Create skill dirs with SKILL.md so they resolve correctly
        const reviewDir = join(runtimeLibRoot, 'skills', 'review');
        const shipDir = join(runtimeLibRoot, 'skills', 'ship');
        const deployDir = join(runtimeLibRoot, 'skills', 'deploy');
        mkdirSync(reviewDir, { recursive: true });
        mkdirSync(shipDir, { recursive: true });
        mkdirSync(deployDir, { recursive: true });
        writeFileSync(join(reviewDir, 'SKILL.md'), '# review', 'utf-8');
        writeFileSync(join(shipDir, 'SKILL.md'), '# ship', 'utf-8');
        writeFileSync(join(deployDir, 'SKILL.md'), '# deploy', 'utf-8');

        const plan = materializeAgentWorkspace({
            agentId: `skill-filter-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'SkillFilterTest',
                runtime: 'claude',
                tools: {
                    skills: ['review', 'ship', 'deploy'],
                },
            },
            launchOverrides: {
                allowedSkills: ['review'],
            },
        });

        expect(existsSync(join(plan.commandsDir, 'review'))).toBe(true);
        expect(existsSync(join(plan.commandsDir, 'ship'))).toBe(false);
        expect(existsSync(join(plan.commandsDir, 'deploy'))).toBe(false);
    });

    it('skill source missing throws error for non-bundled required skills', () => {
        const root = makeTempRoot('aha-skill-missing-');
        const repoRoot = join(root, 'repo');
        const runtimeLibRoot = join(root, 'runtime-lib');

        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(join(runtimeLibRoot, 'skills'), { recursive: true });
        // Intentionally NOT creating the 'nonexistent' skill directory

        expect(() => materializeAgentWorkspace({
            agentId: `skill-missing-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            runtimeLibRoot,
            config: {
                kind: 'aha.agent.v1',
                name: 'SkillMissingTest',
                runtime: 'claude',
                tools: {
                    skills: ['nonexistent'],
                },
            },
        })).toThrow('Skill "nonexistent" declared in skills[] but content is missing.');
    });
});
