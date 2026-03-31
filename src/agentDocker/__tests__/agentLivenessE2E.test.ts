/**
 * Layer 4: Agent Liveness E2E Tests
 *
 * Validates that a materializeAgentWorkspace() output (settingsPath, hooks, skills)
 * actually works end-to-end when passed to the Claude Code SDK.
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY must be set (tests are skipped otherwise)
 *   - claude executable (Claude Code CLI) must be installed
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... yarn vitest run src/agentDocker/__tests__/agentLivenessE2E.test.ts
 */
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
import { query } from '@/claude/sdk';
import type { SDKMessage } from '@/claude/sdk/types';

// ── Gate ──────────────────────────────────────────────────────────────────────

const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

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

// ── Helper: collect all text from SDK message stream ─────────────────────────

async function collectText(q: AsyncIterableIterator<SDKMessage>, timeoutMs: number): Promise<string> {
    const parts: string[] = [];
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Agent response timeout after ${timeoutMs}ms`)), timeoutMs)
    );

    async function drain(): Promise<void> {
        for await (const msg of q) {
            const content = (msg as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
            if (msg.type === 'assistant' && Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        parts.push(block.text);
                    }
                }
            }
            if (msg.type === 'result') break;
        }
    }

    await Promise.race([drain(), timeoutPromise]);
    return parts.join('');
}

// ── Layer 4: Agent Liveness (requires ANTHROPIC_API_KEY) ─────────────────────

describe.skipIf(!hasApiKey)('Layer 4: Agent Liveness E2E', { timeout: 120_000 }, () => {
    it('materialized settings + stop hook fire and agent responds correctly', async () => {
        const root = makeTempRoot('aha-liveness-');
        const repoRoot = join(root, 'repo');
        const hookVerifyFile = join(root, 'stop-hook.txt');
        mkdirSync(repoRoot, { recursive: true });

        // Materialize workspace with a Stop hook that writes a file on session end
        const plan = materializeAgentWorkspace({
            agentId: `liveness-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            config: {
                kind: 'aha.agent.v1',
                name: 'LivenessTestAgent',
                runtime: 'claude',
                hooks: {
                    stop: [
                        {
                            command: `echo "STOP_HOOK_FIRED" > "${hookVerifyFile}"`,
                        },
                    ],
                },
            },
        });

        expect(existsSync(plan.settingsPath)).toBe(true);

        // Spawn Claude with the materialized settingsPath — single-turn prompt
        const q = query({
            prompt: 'Please respond with exactly this text and nothing else: AGENT_ALIVE_OK',
            options: {
                settingsPath: plan.settingsPath,
                cwd: repoRoot,
                maxTurns: 1,
                permissionMode: 'bypassPermissions',
            },
        });

        const responseText = await collectText(q, 90_000);

        // Agent must include the expected token
        expect(responseText).toContain('AGENT_ALIVE_OK');

        // Stop hook must have fired (Claude Code runs hooks after session ends)
        // Allow brief async settle time
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(existsSync(hookVerifyFile)).toBe(true);
        const hookOutput = readFileSync(hookVerifyFile, 'utf-8').trim();
        expect(hookOutput).toBe('STOP_HOOK_FIRED');
    });

    it.skip('skill echo works via test-echo fixture (unblock when Codex Builder delivers fixture)', async () => {
        // Enable this test once examples/test-fixtures/skills/test-echo/SKILL.md is delivered.
        //
        // Steps (when unblocked):
        //   1. const runtimeLibRoot = join(projectRoot, 'examples/test-fixtures');
        //   2. Materialize with skills: ['test-echo'], runtimeLibRoot
        //   3. Spawn query with settingsPath and commandsDir available
        //   4. Prompt: 'Please use the /test-echo skill with message HELLO_WORLD'
        //   5. Expect response to contain '[ECHO] HELLO_WORLD'
    });

    it.skip('PostToolUse hook fires when agent uses Bash tool (unblock for full hook matrix)', async () => {
        // Enable after confirming hook timing with real Claude Code process.
        //
        // Approach:
        //   1. Materialize with PostToolUse Bash hook that appends to a log file
        //   2. Prompt agent to run: `echo test`
        //   3. After response, verify log file contains hook marker
    });
});

// ── Layer 4 static checks (always run) ───────────────────────────────────────

describe('Layer 4: materialized workspace contract for liveness setup', () => {
    it('stop hook is in settings.json with correct structure for agent liveness use', () => {
        const root = makeTempRoot('aha-liveness-static-');
        const repoRoot = join(root, 'repo');
        const hookVerifyFile = join(root, 'stop-hook.txt');
        mkdirSync(repoRoot, { recursive: true });

        const plan = materializeAgentWorkspace({
            agentId: `liveness-static-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            config: {
                kind: 'aha.agent.v1',
                name: 'LivenessStaticCheck',
                runtime: 'claude',
                hooks: {
                    stop: [
                        {
                            command: `echo "STOP_HOOK_FIRED" > "${hookVerifyFile}"`,
                        },
                    ],
                },
            },
        });

        const settings = JSON.parse(readFileSync(plan.settingsPath, 'utf-8')) as {
            hooks?: {
                Stop?: Array<{
                    matcher: string;
                    hooks: Array<{ type: string; command: string }>;
                }>;
            };
        };

        // Settings must have Stop hook entry
        expect(settings.hooks?.Stop).toHaveLength(1);
        const stopEntry = settings.hooks!.Stop![0];
        expect(stopEntry.matcher).toBe('*');
        expect(stopEntry.hooks[0].type).toBe('command');
        expect(stopEntry.hooks[0].command).toContain('STOP_HOOK_FIRED');

        // The settingsPath must point to a valid JSON file
        expect(() => JSON.parse(readFileSync(plan.settingsPath, 'utf-8'))).not.toThrow();
    });

    it('workspace dirs are all created and accessible', () => {
        const root = makeTempRoot('aha-liveness-dirs-');
        const repoRoot = join(root, 'repo');
        mkdirSync(repoRoot, { recursive: true });

        const plan = materializeAgentWorkspace({
            agentId: `liveness-dirs-${Date.now()}`,
            repoRoot,
            runtime: 'claude',
            workspaceMode: 'shared',
            config: {
                kind: 'aha.agent.v1',
                name: 'LivenessDirsCheck',
                runtime: 'claude',
            },
        });

        expect(existsSync(plan.workspaceRoot)).toBe(true);
        expect(existsSync(plan.commandsDir)).toBe(true);
        expect(existsSync(plan.logsDir)).toBe(true);
        expect(existsSync(plan.cacheDir)).toBe(true);
        expect(existsSync(plan.tmpDir)).toBe(true);
        expect(existsSync(plan.settingsPath)).toBe(true);
        expect(existsSync(plan.envFilePath)).toBe(true);
        expect(existsSync(plan.mcpConfigPath)).toBe(true);
    });
});
