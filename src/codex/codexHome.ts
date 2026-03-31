import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentImage } from '@/api/types/genome';
import { linkSharedResource } from '@/agentDocker/materializer';
import { configuration } from '@/configuration';
import {
    extractInlineSkillFileMap,
    listGlobalSkillSources,
    listSkillSourcesInRoot,
    resolveDeclaredSkillSource,
} from '@/skills/skillResolver';

function expandHomePath(value: string): string {
    return value.replace(/^~(?=\/|$)/, homedir());
}

function resolveSourceCodexHome(env: NodeJS.ProcessEnv = process.env): string {
    return expandHomePath(env.CODEX_HOME || join(homedir(), '.codex'));
}

function writeInlineSkill(targetSkillsDir: string, skillName: string, content: string): void {
    const targetSkillDir = join(targetSkillsDir, skillName);
    rmSync(targetSkillDir, { recursive: true, force: true });
    mkdirSync(targetSkillDir, { recursive: true });
    writeFileSync(join(targetSkillDir, 'SKILL.md'), content, 'utf-8');
}

export function seedCodexHomeConfig(
    targetCodexHome: string,
    options: {
        token?: string;
        env?: NodeJS.ProcessEnv;
    } = {},
): void {
    const env = options.env ?? process.env;
    mkdirSync(targetCodexHome, { recursive: true });

    if (options.token) {
        writeFileSync(join(targetCodexHome, 'auth.json'), options.token, 'utf-8');
    }

    const sourceCodexHome = resolveSourceCodexHome(env);
    for (const filename of ['auth.json', 'config.toml', 'config.json', 'settings.json']) {
        if (options.token && filename === 'auth.json') {
            continue;
        }

        const sourcePath = join(sourceCodexHome, filename);
        const targetPath = join(targetCodexHome, filename);
        if (existsSync(sourcePath) && !existsSync(targetPath)) {
            copyFileSync(sourcePath, targetPath);
        }
    }
}

export function seedCodexHomeSkillUnion(
    targetCodexHome: string,
    options: {
        commandsDir?: string | null;
        env?: NodeJS.ProcessEnv;
    } = {},
): void {
    const env = options.env ?? process.env;
    const targetSkillsDir = join(targetCodexHome, 'skills');
    mkdirSync(targetSkillsDir, { recursive: true });

    for (const [, source] of listGlobalSkillSources(env)) {
        linkSharedResource(source.path, join(targetSkillsDir, source.name));
    }

    if (!options.commandsDir) {
        return;
    }

    for (const [, source] of listSkillSourcesInRoot(options.commandsDir, 'commands-dir')) {
        linkSharedResource(source.path, join(targetSkillsDir, source.name));
    }
}

export function materializeAgentImageSkillsToCodexHome(
    targetCodexHome: string,
    options: {
        agentImage: AgentImage;
        runtimeLibRoot?: string | null;
        repoRoot?: string | null;
        env?: NodeJS.ProcessEnv;
    },
): string[] {
    const env = options.env ?? process.env;
    const targetSkillsDir = join(targetCodexHome, 'skills');
    mkdirSync(targetSkillsDir, { recursive: true });

    const warnings: string[] = [];
    const inlineSkillFiles = extractInlineSkillFileMap(options.agentImage.files);
    const runtimeLibRoot = options.runtimeLibRoot === undefined
        ? join(configuration.ahaHomeDir, 'runtime-lib')
        : options.runtimeLibRoot;

    for (const [skillName, content] of Object.entries(inlineSkillFiles)) {
        writeInlineSkill(targetSkillsDir, skillName, content);
    }

    for (const skillName of options.agentImage.skills ?? []) {
        if (inlineSkillFiles[skillName] !== undefined) {
            continue;
        }

        const resolved = resolveDeclaredSkillSource({
            skillName,
            runtimeLibRoot,
            repoRoot: options.repoRoot,
            env,
        });

        if (!resolved) {
            warnings.push(
                `Skill "${skillName}" is declared by the AgentImage but was not found in runtime-lib, repo-local skills, or user skill roots.`,
            );
            continue;
        }

        linkSharedResource(resolved.path, join(targetSkillsDir, skillName));
    }

    return warnings;
}
