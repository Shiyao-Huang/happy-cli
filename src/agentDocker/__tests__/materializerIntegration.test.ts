import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { afterEach, describe, expect, it } from 'vitest';

import {
    materializeAgentWorkspace,
    type MaterializeAgentWorkspaceInput,
    type MaterializeAgentWorkspaceResult,
} from '../materializer';

interface MaterializerIntegrationFixture {
    root: string;
    repoRoot: string;
    runtimeLibRoot: string;
    plan: MaterializeAgentWorkspaceResult;
}

function readJsonFile<T>(path: string): T {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function createMaterializerFixture(
    overrides: Partial<MaterializeAgentWorkspaceInput> = {},
): MaterializerIntegrationFixture {
    const root = mkdtempSync(join(tmpdir(), 'aha-materializer-it-'));
    const repoRoot = join(root, 'repo');
    const runtimeLibRoot = join(root, 'runtime-lib');
    const agentId = `integration-agent-${root.split('/').pop()}`;

    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    const reviewSkillDir = join(runtimeLibRoot, 'skills', 'review');
    const scoreSkillDir = join(runtimeLibRoot, 'skills', 'score');
    mkdirSync(reviewSkillDir, { recursive: true });
    mkdirSync(scoreSkillDir, { recursive: true });
    writeFileSync(join(reviewSkillDir, 'SKILL.md'), '# review', 'utf-8');
    writeFileSync(join(scoreSkillDir, 'SKILL.md'), '# score', 'utf-8');

    const plan = materializeAgentWorkspace({
        agentId,
        repoRoot,
        runtime: 'claude',
        workspaceMode: 'isolated',
        runtimeLibRoot,
        config: {
            kind: 'aha.agent.v1',
            name: 'Integration Reviewer',
            runtime: 'claude',
            tools: {
                skills: ['review', 'score'],
                mcpServers: ['aha'],
            },
            hooks: {
                preToolUse: [{ matcher: 'Read', command: 'echo pre-read' }],
                postToolUse: [{ matcher: 'Edit', command: 'echo post-edit' }],
            },
            env: {
                required: ['AHA_ROOM_ID'],
                optional: ['AHA_SESSION_ID'],
            },
            workspace: {
                defaultMode: 'isolated',
                allowedModes: ['shared', 'isolated'],
            },
        },
        launchOverrides: {
            env: {
                AHA_ROOM_ID: 'team-123',
                AHA_SESSION_ID: 'session-456',
            },
            allowedSkills: ['review'],
        },
        ...overrides,
    });

    return {
        root,
        repoRoot,
        runtimeLibRoot,
        plan,
    };
}

describe('materializer integration scaffold (for QA closure)', () => {
    const cleanupRoots: string[] = [];

    afterEach(() => {
        while (cleanupRoots.length > 0) {
            const root = cleanupRoots.pop();
            if (root && existsSync(root)) {
                rmSync(root, { recursive: true, force: true });
            }
        }
    });

    it('creates a reusable isolated workspace fixture with materialized artifacts', () => {
        const fixture = createMaterializerFixture();
        cleanupRoots.push(fixture.root);

        expect(fixture.plan.workspaceMode).toBe('isolated');
        expect(existsSync(fixture.plan.workspaceRoot)).toBe(true);
        expect(existsSync(fixture.plan.settingsPath)).toBe(true);
        expect(existsSync(fixture.plan.envFilePath)).toBe(true);
        expect(existsSync(fixture.plan.mcpConfigPath)).toBe(true);

        const settings = readJsonFile<{ hooks: Record<string, unknown[]> }>(fixture.plan.settingsPath);
        expect(settings.hooks.PreToolUse).toHaveLength(1);
        expect(settings.hooks.PostToolUse).toHaveLength(1);

        const envJson = readJsonFile<{
            required: string[];
            optional: string[];
            launchOverrides: Record<string, string>;
        }>(fixture.plan.envFilePath);
        expect(envJson.required).toEqual(['AHA_ROOM_ID']);
        expect(envJson.optional).toEqual(['AHA_SESSION_ID']);
        expect(envJson.launchOverrides.AHA_ROOM_ID).toBe('team-123');

        const mcpJson = readJsonFile<{ mcpServers: string[] }>(fixture.plan.mcpConfigPath);
        expect(mcpJson.mcpServers).toEqual(['aha']);

        // In isolated mode, projectViewPath is a deep copy of repoRoot (not a symlink).
        // Verify the copy exists and the paths are distinct (write-isolated).
        expect(existsSync(fixture.plan.projectViewPath)).toBe(true);
        expect(realpathSync(fixture.plan.projectViewPath)).not.toBe(realpathSync(fixture.repoRoot));
        expect(realpathSync(join(fixture.plan.commandsDir, 'review'))).toBe(
            realpathSync(join(fixture.runtimeLibRoot, 'skills', 'review')),
        );
        expect(existsSync(join(fixture.plan.commandsDir, 'score'))).toBe(false);
    });

    it('captures the contract paths that runClaude integration must consume later', () => {
        const fixture = createMaterializerFixture({
            workspaceMode: 'shared',
        });
        cleanupRoots.push(fixture.root);

        expect(fixture.plan.workspaceMode).toBe('shared');
        expect(fixture.plan.effectiveCwd).toBe(fixture.repoRoot);
        expect(fixture.plan.actions.some((action) => action.kind === 'write-settings')).toBe(true);
        expect(fixture.plan.actions.some((action) => action.kind === 'write-env')).toBe(true);
        expect(fixture.plan.actions.some((action) => action.kind === 'write-mcp-config')).toBe(true);
        expect(fixture.plan.actions.some((action) => action.kind === 'attach-repo')).toBe(true);
    });

    it.skip('wires settingsPath through runClaude -> loop -> launcher once materializer v1 lands', () => {
        // QA enable point:
        // 1. buildAgentWorkspacePlanFromGenome() + executeAgentWorkspacePlan() are wired into runClaude.ts
        // 2. runClaude passes plan/settingsPath into loop()
        // 3. loop/launcher chain forwards it to Claude --settings
    });

    it.skip('switches isolated launches to plan.effectiveCwd once runClaude consumes materializer output', () => {
        // QA enable point:
        // 1. runClaude uses plan.effectiveCwd for isolated sessions
        // 2. launcher/runtime assertions can verify projectViewPath is the cwd boundary
    });
});
