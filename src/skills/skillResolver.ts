import { Dirent, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SkillSourceKind =
    | 'runtime-lib'
    | 'repo-local'
    | 'user-root'
    | 'commands-dir';

export interface SkillSourceDescriptor {
    name: string;
    path: string;
    root: string;
    kind: SkillSourceKind;
}

function expandHomePath(value: string): string {
    return value.replace(/^~(?=\/|$)/, homedir());
}

function uniquePaths(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of values) {
        if (!value) continue;
        const normalized = expandHomePath(value.trim());
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }

    return result;
}

function hasSkillMarkdown(path: string): boolean {
    return existsSync(join(path, 'SKILL.md'));
}

export function extractInlineSkillFileMap(files?: Record<string, string> | null): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [relativePath, content] of Object.entries(files ?? {})) {
        if (typeof content !== 'string') continue;
        const normalized = relativePath.replace(/\\/g, '/');
        const match = normalized.match(/^\.claude\/commands\/([^/]+)\/SKILL\.md$/i);
        if (!match?.[1]) continue;
        result[match[1]] = content;
    }

    return result;
}

export function getGlobalSkillRoots(env: NodeJS.ProcessEnv = process.env): string[] {
    const configuredRoots = env.AHA_SKILL_ROOTS?.split(':').map((value) => value.trim()).filter(Boolean) ?? [];
    const codexHome = env.CODEX_HOME ? join(expandHomePath(env.CODEX_HOME), 'skills') : null;
    const userHome = homedir();

    return uniquePaths([
        ...configuredRoots,
        codexHome,
        join(userHome, '.codex', 'skills'),
        join(userHome, '.agents', 'skills'),
    ]);
}

export function listSkillSourcesInRoot(
    root: string,
    kind: SkillSourceKind,
): Map<string, SkillSourceDescriptor> {
    const result = new Map<string, SkillSourceDescriptor>();
    if (!existsSync(root)) return result;

    let entries: Dirent[];
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return result;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sourcePath = join(root, entry.name);
        if (!hasSkillMarkdown(sourcePath)) continue;
        result.set(entry.name, {
            name: entry.name,
            path: sourcePath,
            root,
            kind,
        });
    }

    return result;
}

export function listGlobalSkillSources(env: NodeJS.ProcessEnv = process.env): Map<string, SkillSourceDescriptor> {
    const result = new Map<string, SkillSourceDescriptor>();

    for (const root of getGlobalSkillRoots(env)) {
        for (const [name, descriptor] of listSkillSourcesInRoot(root, 'user-root')) {
            if (!result.has(name)) {
                result.set(name, descriptor);
            }
        }
    }

    return result;
}

export function resolveDeclaredSkillSource(input: {
    skillName: string;
    runtimeLibRoot?: string | null;
    repoRoot?: string | null;
    env?: NodeJS.ProcessEnv;
}): SkillSourceDescriptor | null {
    const runtimeLibRoot = input.runtimeLibRoot ? join(input.runtimeLibRoot, 'skills', input.skillName) : null;
    if (runtimeLibRoot && hasSkillMarkdown(runtimeLibRoot)) {
        return {
            name: input.skillName,
            path: runtimeLibRoot,
            root: join(input.runtimeLibRoot!, 'skills'),
            kind: 'runtime-lib',
        };
    }

    const repoLocalRoot = input.repoRoot ? join(input.repoRoot, 'skills', input.skillName) : null;
    if (repoLocalRoot && hasSkillMarkdown(repoLocalRoot)) {
        return {
            name: input.skillName,
            path: repoLocalRoot,
            root: join(input.repoRoot!, 'skills'),
            kind: 'repo-local',
        };
    }

    return listGlobalSkillSources(input.env).get(input.skillName) ?? null;
}
