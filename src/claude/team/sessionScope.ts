import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Metadata } from '@/api/types';

export interface SessionScope {
    scopePath: string;
    scopeLabel: string;
    repoName: string;
    visibility: 'scoped';
}

export interface SessionScopeFilters {
    scopePath?: string;
    repoName?: string;
    includeGlobal?: boolean;
}

const execFileAsync = promisify(execFile);
const KNOWN_REPO_PREFIXES = ['aha-cli', 'genome-hub', 'happy-server', 'kanban'] as const;

function deriveRepoName(label: string): string {
    for (const prefix of KNOWN_REPO_PREFIXES) {
        if (label === prefix || label.startsWith(`${prefix}-`)) {
            return prefix;
        }
    }

    const parts = label.split('-');
    if (parts.length >= 2) {
        return `${parts[0]}-${parts[1]}`;
    }
    return label;
}

export function buildSessionScope(metadata?: Metadata | null): SessionScope | null {
    const scopePath = metadata?.path?.trim();
    if (!scopePath) {
        return null;
    }

    const scopeLabel = metadata?.runtimeBuild?.worktreeName?.trim() || path.basename(scopePath);
    return {
        scopePath,
        scopeLabel,
        repoName: deriveRepoName(scopeLabel),
        visibility: 'scoped',
    };
}

export function buildSessionScopeFilters(metadata?: Metadata | null): SessionScopeFilters | undefined {
    const scope = buildSessionScope(metadata);
    if (!scope) {
        return undefined;
    }

    return {
        scopePath: scope.scopePath,
        repoName: scope.repoName,
        includeGlobal: true,
    };
}

export function matchesSessionScopeFilter(
    scope: unknown,
    filters?: SessionScopeFilters,
): boolean {
    if (!filters?.scopePath && !filters?.repoName) {
        return true;
    }

    const includeGlobal = filters.includeGlobal !== false;
    if (!scope || typeof scope !== 'object') {
        return includeGlobal;
    }

    const raw = scope as Record<string, unknown>;
    const scopePath = typeof raw.scopePath === 'string' ? raw.scopePath : undefined;
    const repoName = typeof raw.repoName === 'string' ? raw.repoName : undefined;
    const visibility = raw.visibility === 'global' || raw.visibility === 'scoped'
        ? raw.visibility
        : undefined;

    if (!scopePath) {
        return includeGlobal;
    }

    if (visibility === 'global') {
        return includeGlobal;
    }

    if (filters.scopePath && scopePath === filters.scopePath) {
        return true;
    }

    if (filters.repoName && repoName === filters.repoName) {
        return true;
    }

    return false;
}

export async function resolveSessionCommitHash(metadata?: Metadata | null): Promise<string | null> {
    const cwd = metadata?.path?.trim();
    if (!cwd) {
        return null;
    }

    try {
        const result = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd,
            timeout: 3_000,
        });
        const value = result.stdout.trim();
        return value.length > 0 ? value : null;
    } catch {
        return null;
    }
}
