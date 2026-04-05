import fs from 'node:fs';
import path from 'node:path';

export type AgentLaunchContext = {
    scopeSummary?: string;
    prompt: string;
    guidanceFiles: string[];
};

type InstructionDoc = {
    path: string;
    content: string;
};

const MAX_DISCOVERED_AGENT_INSTRUCTION_BYTES = 32 * 1024;

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

function findNearestGitRoot(startDir: string): string | null {
    let current = path.resolve(startDir);

    while (true) {
        const candidate = path.join(current, '.git');
        if (fs.existsSync(candidate)) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
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

function buildDirectoryChain(projectRoot: string, directory: string): string[] {
    const resolvedRoot = path.resolve(projectRoot);
    const resolvedDirectory = path.resolve(directory);

    if (resolvedRoot === resolvedDirectory) {
        return [resolvedRoot];
    }

    const relative = path.relative(resolvedRoot, resolvedDirectory);
    if (!relative || relative.startsWith('..')) {
        return [resolvedDirectory];
    }

    const chain = [resolvedRoot];
    let current = resolvedRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        chain.push(current);
    }
    return chain;
}

function discoverAgentsInstructionDocs(directory: string, projectRoot: string): InstructionDoc[] {
    const docs: InstructionDoc[] = [];
    let totalBytes = 0;

    for (const dir of buildDirectoryChain(projectRoot, directory)) {
        const candidate = path.join(dir, 'AGENTS.md');
        if (!fs.existsSync(candidate)) {
            continue;
        }

        const stat = fs.statSync(candidate);
        if (!stat.isFile()) {
            continue;
        }

        const content = fs.readFileSync(candidate, 'utf-8').trim();
        if (!content) {
            continue;
        }

        const contentBytes = Buffer.byteLength(content, 'utf-8');
        if (totalBytes + contentBytes > MAX_DISCOVERED_AGENT_INSTRUCTION_BYTES) {
            break;
        }

        docs.push({
            path: path.resolve(candidate),
            content,
        });
        totalBytes += contentBytes;
    }

    return docs;
}

function formatAgentsInstructionDocs(docs: InstructionDoc[]): string | null {
    if (docs.length === 0) {
        return null;
    }

    return docs.map((doc) => [
        `# AGENTS.md instructions for ${path.dirname(doc.path)}`,
        '',
        '<INSTRUCTIONS>',
        doc.content,
        '</INSTRUCTIONS>',
    ].join('\n')).join('\n\n');
}

function formatPredecessorHandoff(content: string, sessionId?: string): string {
    const header = sessionId
        ? `## Predecessor Handoff (from session ${sessionId})`
        : '## Predecessor Handoff';
    return [
        '<attached_predecessor_handoff>',
        header,
        '',
        content,
        '</attached_predecessor_handoff>',
    ].join('\n');
}

export function buildAgentLaunchContext(options: {
    directory: string;
    existingPrompt?: string;
    includeTeamHelpLane?: boolean;
    includeProjectInstructions?: boolean;
    /** Handoff note from a predecessor session — injected as read-only context for the new agent. */
    predecessorHandoff?: string;
    /** Session ID of the predecessor, used for display only. */
    predecessorSessionId?: string;
}): AgentLaunchContext {
    const directory = path.resolve(options.directory);
    const systemPath = toDisplayPath(findNearestFile(directory, 'SYSTEM.md'));
    const agentsPath = toDisplayPath(findNearestFile(directory, 'AGENTS.md'));
    const guidanceFiles = [systemPath, agentsPath].filter((value): value is string => Boolean(value));
    const projectRoot = findNearestGitRoot(directory) ?? path.dirname(systemPath || agentsPath || directory);

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
    const projectInstructions = options.includeProjectInstructions
        ? formatAgentsInstructionDocs(discoverAgentsInstructionDocs(directory, projectRoot))
        : null;

    const predecessorHandoffSection = options.predecessorHandoff?.trim()
        ? formatPredecessorHandoff(options.predecessorHandoff.trim(), options.predecessorSessionId)
        : null;

    return {
        scopeSummary: scopeParts.join('; '),
        prompt: [existingPrompt, predecessorHandoffSection, projectInstructions, promptLines.join('\n')]
            .filter((value): value is string => Boolean(value?.trim()))
            .join('\n\n'),
        guidanceFiles,
    };
}
