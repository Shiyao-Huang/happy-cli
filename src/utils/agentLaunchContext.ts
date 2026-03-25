import fs from 'node:fs';
import path from 'node:path';

export type AgentLaunchContext = {
    scopeSummary?: string;
    prompt: string;
    guidanceFiles: string[];
};

function findNearestFile(startDir: string, fileName: string): string | null {
    let current = path.resolve(startDir);

    while (true) {
        const candidate = path.join(current, fileName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

function toDisplayPath(filePath: string | null): string | null {
    return filePath ? path.resolve(filePath) : null;
}

function buildPrimaryWriteScope(directory: string, projectRoot: string): string {
    const relative = path.relative(projectRoot, directory).replace(/\\/g, '/').trim();
    if (!relative || relative === '.') {
        return `${path.resolve(directory)}/**`;
    }
    return `${relative}/**`;
}

function listSiblingProjectScopes(projectRoot: string, directory: string): string[] {
    const relative = path.relative(projectRoot, directory).replace(/\\/g, '/').trim();
    const topLevelActiveSegment = relative && relative !== '.'
        ? relative.split('/')[0]
        : null;

    try {
        return fs.readdirSync(projectRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .filter((name) => name !== topLevelActiveSegment)
            .slice(0, 6)
            .map((name) => `${name}/**`);
    } catch {
        return [];
    }
}

export function buildAgentLaunchContext(options: {
    directory: string;
    existingPrompt?: string;
    includeTeamHelpLane?: boolean;
}): AgentLaunchContext {
    const directory = path.resolve(options.directory);
    const systemPath = toDisplayPath(findNearestFile(directory, 'SYSTEM.md'));
    const agentsPath = toDisplayPath(findNearestFile(directory, 'AGENTS.md'));
    const guidanceFiles = [systemPath, agentsPath].filter((value): value is string => Boolean(value));
    const projectRoot = path.dirname(systemPath || agentsPath || directory);

    const primaryWriteScope = buildPrimaryWriteScope(directory, projectRoot);
    const siblingScopes = listSiblingProjectScopes(projectRoot, directory);

    const scopeParts = [
        `Primary write scope: ${primaryWriteScope}`,
        siblingScopes.length > 0
            ? `Avoid sibling project trees unless explicitly assigned: ${siblingScopes.join(', ')}`
            : null,
        guidanceFiles.length > 0
            ? 'Guidance docs are read-only context unless explicitly assigned: SYSTEM.md, AGENTS.md'
            : null,
    ].filter((value): value is string => Boolean(value));

    const promptLines = [
        '## Spawn-Time Boundary Context',
        guidanceFiles.length > 0
            ? `- Read first: ${guidanceFiles.join(' ; ')}`
            : '- Read the nearest SYSTEM.md / AGENTS.md if they exist before touching shared files.',
        `- ${scopeParts[0]}`,
        ...(scopeParts[1] ? [`- ${scopeParts[1]}`] : []),
        ...(scopeParts[2] ? [`- ${scopeParts[2]}`] : []),
        options.includeTeamHelpLane
            ? '- Help lane: if blocked, call `request_help` with evidence or mention `@help` in team chat with what you tried and what you need.'
            : '- Help lane: if blocked, call `request_help` with evidence instead of waiting silently.',
        '- Context mirror: call `get_context_status` at task start, after loading large context, and before long summaries.',
    ];

    const existingPrompt = options.existingPrompt?.trim();

    return {
        scopeSummary: scopeParts.join('; '),
        prompt: existingPrompt
            ? `${existingPrompt}\n\n${promptLines.join('\n')}`
            : promptLines.join('\n'),
        guidanceFiles,
    };
}
