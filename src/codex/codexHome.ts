import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

type TomlSection = {
    header: string | null;
    lines: string[];
};

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

function splitTomlSections(source: string): TomlSection[] {
    const sections: TomlSection[] = [];
    let current: TomlSection = { header: null, lines: [] };

    for (const line of source.split(/\r?\n/)) {
        const sectionMatch = line.match(/^\s*\[(.+)\]\s*$/);
        if (sectionMatch) {
            sections.push(current);
            current = {
                header: sectionMatch[1].trim(),
                lines: [line],
            };
            continue;
        }

        current.lines.push(line);
    }

    sections.push(current);
    return sections;
}

function isMarketplaceSection(header: string | null): boolean {
    if (!header) {
        return false;
    }

    const root = header.split('.')[0]?.replace(/^"|"$/g, '');
    return root === 'marketplaces';
}

function buildIsolatedCodexConfig(sourceConfig: string | null): string {
    const sections = splitTomlSections(sourceConfig ?? '').filter((section) => !isMarketplaceSection(section.header));
    let hasFeaturesSection = false;

    for (const section of sections) {
        if (section.header !== 'features') {
            continue;
        }

        hasFeaturesSection = true;
        const retainedLines = section.lines.filter((line, index) => {
            if (index === 0) {
                return true;
            }

            return !/^\s*(plugins|shell_snapshot)\s*=/.test(line);
        });

        if (retainedLines.length > 0 && retainedLines[retainedLines.length - 1].trim() !== '') {
            retainedLines.push('');
        }

        retainedLines.push('plugins = false');
        retainedLines.push('shell_snapshot = false');
        section.lines = retainedLines;
    }

    if (!hasFeaturesSection) {
        if (sections.length > 0 && sections[sections.length - 1].lines.at(-1)?.trim() !== '') {
            sections[sections.length - 1].lines.push('');
        }

        sections.push({
            header: 'features',
            lines: [
                '[features]',
                'plugins = false',
                'shell_snapshot = false',
            ],
        });
    }

    return `${sections
        .map((section) => section.lines.join('\n').replace(/\n+$/g, ''))
        .filter((section) => section.length > 0)
        .join('\n\n')
        .trim()}\n`;
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
    const sourceConfigPath = join(sourceCodexHome, 'config.toml');
    const targetConfigPath = join(targetCodexHome, 'config.toml');
    for (const filename of [
        'auth.json',
        'config.json',
        'settings.json',
        '.codex-global-state.json',
        'installation_id',
        'models_cache.json',
        'session_index.jsonl',
        'version.json',
        'state_5.sqlite',
        'state_5.sqlite-shm',
        'state_5.sqlite-wal',
    ]) {
        if (options.token && filename === 'auth.json') {
            continue;
        }

        const sourcePath = join(sourceCodexHome, filename);
        const targetPath = join(targetCodexHome, filename);
        if (existsSync(sourcePath) && !existsSync(targetPath)) {
            copyFileSync(sourcePath, targetPath);
        }
    }

    const sourceConfig = existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, 'utf-8') : null;
    writeFileSync(targetConfigPath, buildIsolatedCodexConfig(sourceConfig), 'utf-8');

    for (const dirname of ['sqlite']) {
        const sourcePath = join(sourceCodexHome, dirname);
        const targetPath = join(targetCodexHome, dirname);
        if (existsSync(sourcePath) && !existsSync(targetPath)) {
            cpSync(sourcePath, targetPath, { recursive: true });
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
