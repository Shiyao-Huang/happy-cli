/**
 * prepareAgentRuntime — bridges agent-json-v1 config into Claude Code runtime.
 *
 * Converts agent.json fields that have no direct SDK option into
 * artifacts the CLI can consume:
 *
 *   hooks   → temporary settings JSON file (consumed via --settings flag)
 *   skills  → system prompt injection text
 *   env     → validated environment variable contract + materialized env.json
 *
 * The returned RuntimePreparation is consumed by runClaude.ts at startup.
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '@/ui/logger';
import { buildHooksSettingsContent, hasAgentHooks } from './hooksSettings';
import type { AgentHooks } from './hooksSettings';

// ── Types ────────────────────────────────────────────────────────────────────
export type {
    AgentHookEntry,
    AgentStopHookEntry,
    AgentHooks,
} from './hooksSettings';

export interface RuntimePreparation {
    /** Path to temporary settings JSON with hooks. null = no hooks. */
    settingsPath: string | null;

    /** Path to temporary env materialization JSON. null = no env contract/materialization. */
    envFilePath: string | null;

    /** Environment variables resolved from process env + launch overrides. */
    envVars: Record<string, string>;

    /** Build-time artifact summary for launcher/runtime integration. */
    build: {
        artifacts: {
            settingsPath: string | null;
            envFilePath: string | null;
        };
        missingRequiredEnv: string[];
        warnings: string[];
    };

    /** Skills injection text to append to system prompt. empty = no skills. */
    skillsInjection: string;

    /** maxTurns from genome spec. undefined = not set. */
    maxTurns: number | undefined;

    /** Cleanup function — removes temp files. Call on session exit. */
    cleanup: () => void;
}

// ── Hooks → Settings File ────────────────────────────────────────────────────

function writeGeneratedJsonFile(prefix: string, payload: Record<string, unknown>): string {
    const dir = join(tmpdir(), 'aha-agent-settings');
    mkdirSync(dir, { recursive: true });

    const filePath = join(dir, `${prefix}-${randomUUID()}.json`);
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return filePath;
}

function writeHooksSettingsFile(hooks: AgentHooks): string | null {
    if (!hasAgentHooks(hooks)) return null;

    const settings = buildHooksSettingsContent(hooks);

    const filePath = writeGeneratedJsonFile('agent-hooks', settings);
    logger.debug(`[prepareAgentRuntime] Hooks settings written to ${filePath}`);
    return filePath;
}

// ── Skills → System Prompt Injection ─────────────────────────────────────────

function buildSkillsInjection(skills?: string[]): string {
    if (!skills?.length) return '';

    return [
        '## Available Agent Skills',
        '',
        ...skills.map(s => `- /${s}`),
        '',
        'Use these skills when they match the current task.',
    ].join('\n');
}

// ── Env Validation ───────────────────────────────────────────────────────────

function validateEnvContract(
    required?: string[],
    optional?: string[],
    overrides?: Record<string, string>,
): { missing: string[]; warnings: string[] } {
    const missing: string[] = [];
    const warnings: string[] = [];
    const resolvedEnv = overrides ?? {};

    for (const key of required ?? []) {
        if (!resolvedEnv[key] && !process.env[key]) {
            missing.push(key);
        }
    }

    for (const key of optional ?? []) {
        if (!resolvedEnv[key] && !process.env[key]) {
            warnings.push(`Optional env var ${key} is not set`);
        }
    }

    return { missing, warnings };
}

function materializeEnvFile(opts: {
    required?: string[];
    optional?: string[];
    overrides?: Record<string, string>;
}): {
    envFilePath: string | null;
    envVars: Record<string, string>;
    missingRequiredEnv: string[];
    warnings: string[];
} {
    const required = Array.from(new Set(opts.required ?? []));
    const optional = Array.from(new Set(opts.optional ?? []));
    const overrides: Record<string, string> = opts.overrides ?? {};
    const overrideEntries = Object.entries(overrides);
    const declaredKeys = Array.from(new Set([
        ...required,
        ...optional,
        ...overrideEntries.map(([key]) => key),
    ]));

    const envVars: Record<string, string> = {};
    const sources: Record<string, 'processEnv' | 'launchOverride'> = {};

    for (const key of declaredKeys) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
            envVars[key] = overrides[key];
            sources[key] = 'launchOverride';
            continue;
        }

        const value = process.env[key];
        if (value !== undefined) {
            envVars[key] = value;
            sources[key] = 'processEnv';
        }
    }

    const envResult = validateEnvContract(required, optional, overrides);

    if (declaredKeys.length === 0) {
        return {
            envFilePath: null,
            envVars,
            missingRequiredEnv: envResult.missing,
            warnings: envResult.warnings,
        };
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        required,
        optional,
        values: envVars,
        sources,
        missingRequired: envResult.missing,
    };
    const envFilePath = writeGeneratedJsonFile('agent-env', payload);

    logger.debug(`[prepareAgentRuntime] Env materialization written to ${envFilePath}`);

    return {
        envFilePath,
        envVars,
        missingRequiredEnv: envResult.missing,
        warnings: envResult.warnings,
    };
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export function prepareAgentRuntime(opts: {
    hooks?: AgentHooks;
    skills?: string[];
    maxTurns?: number;
    envRequired?: string[];
    envOptional?: string[];
    envOverrides?: Record<string, string>;
}): RuntimePreparation {
    // 1. Hooks → settings file
    const settingsPath = opts.hooks
        ? writeHooksSettingsFile(opts.hooks)
        : null;

    // 2. Skills → prompt injection
    const skillsInjection = buildSkillsInjection(opts.skills);

    // 3. Env validation + materialization
    const envResult = materializeEnvFile({
        required: opts.envRequired,
        optional: opts.envOptional,
        overrides: opts.envOverrides,
    });
    if (envResult.missingRequiredEnv.length > 0) {
        logger.debug(`[prepareAgentRuntime] Missing required env vars: ${envResult.missingRequiredEnv.join(', ')}`);
    }
    for (const w of envResult.warnings) {
        logger.debug(`[prepareAgentRuntime] ${w}`);
    }

    // 4. Cleanup function
    const cleanup = () => {
        for (const path of [settingsPath, envResult.envFilePath]) {
            if (!path || !existsSync(path)) continue;
            try {
                rmSync(path);
                logger.debug(`[prepareAgentRuntime] Cleaned up ${path}`);
            } catch {
                // best-effort cleanup
            }
        }
    };

    return {
        settingsPath,
        envFilePath: envResult.envFilePath,
        envVars: envResult.envVars,
        build: {
            artifacts: {
                settingsPath,
                envFilePath: envResult.envFilePath,
            },
            missingRequiredEnv: envResult.missingRequiredEnv,
            warnings: envResult.warnings,
        },
        skillsInjection,
        maxTurns: opts.maxTurns,
        cleanup,
    };
}
