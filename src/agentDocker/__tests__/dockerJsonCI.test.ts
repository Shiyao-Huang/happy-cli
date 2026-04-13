/**
 * Docker JSON CI 验证测试
 *
 * 测试覆盖：
 * 1. 所有 examples/agent-json/*.json 文件通过 agent-json-v1.schema.json 校验
 * 2. 每种配置可成功物化（materializeAgentWorkspace），生成正确的产物
 * 3. 关键契约路径（settings.json / env.json / mcp.json）内容验证
 *
 * 用法（CI）：
 *   yarn vitest run src/agentDocker/__tests__/dockerJsonCI.test.ts
 */
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    materializeAgentWorkspace,
    type AgentDockerConfig,
    type WorkspaceMode,
} from '../materializer';

// ── Paths ─────────────────────────────────────────────────────────────────────

const projectRoot = join(__dirname, '..', '..', '..');
const examplesDir = join(projectRoot, 'examples', 'agent-json');
const schemaPath = join(projectRoot, 'schemas', 'agent-json-v1.schema.json');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const tempRoots: string[] = [];

function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'aha-docker-ci-'));
    tempRoots.push(root);
    return root;
}

// ── Schema validator ──────────────────────────────────────────────────────────

let validate: any;

beforeAll(() => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    validate = ajv.compile(schema);
});

afterAll(() => {
    for (const root of tempRoots) {
        if (existsSync(root)) {
            rmSync(root, { recursive: true, force: true });
        }
    }
});

// ── Helper: cast agent-json-v1 → AgentDockerConfig ───────────────────────────

function agentJsonToDockerConfig(raw: Record<string, unknown>): AgentDockerConfig {
    const tools = raw.tools as Record<string, unknown> | undefined;
    const hooks = raw.hooks as Record<string, unknown> | undefined;
    const env = raw.env as Record<string, unknown> | undefined;
    const workspace = raw.workspace as Record<string, unknown> | undefined;

    return {
        kind: 'aha.agent.v1',
        name: (raw.name as string) ?? 'agent',
        runtime: ((raw.runtime as string) ?? 'claude') as AgentDockerConfig['runtime'],
        tools: tools
            ? {
                mcpServers: tools.mcpServers as string[] | undefined,
                skills: tools.skills as string[] | undefined,
            }
            : undefined,
        hooks: hooks
            ? {
                preToolUse: hooks.preToolUse as AgentDockerConfig['hooks'] extends { preToolUse?: infer U } ? U : never,
                postToolUse: hooks.postToolUse as AgentDockerConfig['hooks'] extends { postToolUse?: infer U } ? U : never,
                stop: hooks.stop as AgentDockerConfig['hooks'] extends { stop?: infer U } ? U : never,
            }
            : undefined,
        env: env
            ? {
                required: env.required as string[] | undefined,
                optional: env.optional as string[] | undefined,
            }
            : undefined,
        workspace: workspace
            ? {
                defaultMode: workspace.defaultMode as WorkspaceMode | undefined,
                allowedModes: workspace.allowedModes as WorkspaceMode[] | undefined,
            }
            : undefined,
    };
}

// ── Example files to test ─────────────────────────────────────────────────────

const exampleFiles = [
    { file: 'supervisor.agent.json', expectedRuntime: 'claude', expectedMode: 'shared' },
    { file: 'builder.agent.json', expectedRuntime: 'claude', expectedMode: 'isolated' },
    { file: 'codex-worker.agent.json', expectedRuntime: 'codex', expectedMode: 'shared' },
    { file: 'qa.agent.json', expectedRuntime: 'claude', expectedMode: 'shared' },
] as const;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('agent-json-v1 schema validation (CI)', () => {
    for (const { file } of exampleFiles) {
        it(`validates ${file} against agent-json-v1.schema.json`, () => {
            const filePath = join(examplesDir, file);
            expect(existsSync(filePath), `${file} must exist`).toBe(true);

            const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
            const valid = validate(raw);
            if (!valid) {
                throw new Error(
                    `Schema validation failed for ${file}:\n${JSON.stringify(validate.errors, null, 2)}`
                );
            }
            expect(valid).toBe(true);
        });
    }
});

describe('materializer smoke test (CI)', () => {
    for (const { file, expectedRuntime, expectedMode } of exampleFiles) {
        it(`materializes ${file} and produces correct artifacts`, () => {
            const filePath = join(examplesDir, file);
            const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
            const config = agentJsonToDockerConfig(raw);

            const root = makeTempRoot();
            const repoRoot = join(root, 'repo');
            const runtimeLibRoot = join(root, 'runtime-lib');

            mkdirSync(join(repoRoot, 'src'), { recursive: true });

            // Create skill dirs referenced by config (if any)
            for (const skill of config.tools?.skills ?? []) {
                const skillDir = join(runtimeLibRoot, 'skills', skill);
                mkdirSync(skillDir, { recursive: true });
                writeFileSync(
                    join(skillDir, 'SKILL.md'),
                    `# ${skill}\n\nFixture skill for docker materializer CI.\n`
                );
            }

            const plan = materializeAgentWorkspace({
                agentId: `ci-${file.replace('.json', '')}-${Date.now()}`,
                repoRoot,
                runtime: config.runtime,
                config,
                workspaceMode: config.workspace?.defaultMode,
                runtimeLibRoot,
            });

            // Runtime and workspace mode
            expect(plan.workspaceMode).toBe(expectedMode);

            // All artifact files must exist
            expect(existsSync(plan.settingsPath), 'settings.json must exist').toBe(true);
            expect(existsSync(plan.envFilePath), 'env.json must exist').toBe(true);
            expect(existsSync(plan.mcpConfigPath), 'mcp.json must exist').toBe(true);
            expect(existsSync(plan.workspaceRoot), 'workspaceRoot must exist').toBe(true);
            expect(existsSync(plan.commandsDir), 'commandsDir must exist').toBe(true);

            // settings.json must be valid JSON
            const settings = JSON.parse(readFileSync(plan.settingsPath, 'utf-8'));
            expect(typeof settings).toBe('object');
            // When hooks are actually defined, 'hooks' key must be present in settings
            const hasHooks = config.hooks && (
                (config.hooks.preToolUse?.length ?? 0) > 0 ||
                (config.hooks.postToolUse?.length ?? 0) > 0 ||
                (config.hooks.stop?.length ?? 0) > 0
            );
            if (hasHooks) {
                expect(settings).toHaveProperty('hooks');
            }

            // env.json must have required and optional arrays
            const envJson = JSON.parse(readFileSync(plan.envFilePath, 'utf-8'));
            expect(Array.isArray(envJson.required)).toBe(true);
            expect(Array.isArray(envJson.optional)).toBe(true);

            // mcp.json must have mcpServers field
            const mcpJson = JSON.parse(readFileSync(plan.mcpConfigPath, 'utf-8'));
            expect(mcpJson).toHaveProperty('mcpServers');

            // Skill symlinks must exist for each allowed skill
            for (const skill of config.tools?.skills ?? []) {
                const skillLink = join(plan.commandsDir, skill);
                expect(existsSync(skillLink), `skill symlink ${skill} must exist`).toBe(true);
            }

            // Warn on any materialization warnings
            if (plan.warnings.length > 0) {
                console.warn(`[${file}] Materializer warnings:`, plan.warnings);
            }

            // Runtime field check
            expect(config.runtime).toBe(expectedRuntime);
        });
    }
});
