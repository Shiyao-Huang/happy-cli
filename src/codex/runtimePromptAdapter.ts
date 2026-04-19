import { trimIdent } from '@/utils/trimIdent';

function uniqueStrings(values?: Array<string | null | undefined>): string[] {
    if (!values?.length) {
        return [];
    }

    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (!trimmed) {
            continue;
        }
        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(trimmed);
    }

    return result;
}

export function buildCodexCustomSystemPromptBlock(prompt?: string | null): string | undefined {
    const trimmed = prompt?.trim();
    if (!trimmed) {
        return undefined;
    }

    return trimIdent(`
        <codex_custom_system_prompt>
        Treat the following block as high-priority runtime instructions attached by Aha.
        Keep following your role, genome, and team protocols unless this block explicitly refines them.

        ${trimmed}
        </codex_custom_system_prompt>
    `);
}

export function buildCodexToolAccessInstruction(args: {
    allowedTools?: string[] | null;
    disallowedTools?: string[] | null;
}): string | undefined {
    const allowedTools = uniqueStrings(args.allowedTools ?? []);
    const disallowedTools = uniqueStrings(args.disallowedTools ?? []);

    if (allowedTools.length === 0 && disallowedTools.length === 0) {
        return undefined;
    }

    const lines = ['## Runtime Tool Access Contract'];

    if (allowedTools.length > 0) {
        lines.push(`- Allowed/preferred Aha tools: ${allowedTools.join(', ')}`);
    }
    if (disallowedTools.length > 0) {
        lines.push(`- Disallowed Aha tools: ${disallowedTools.join(', ')}`);
    }

    lines.push('- Respect this contract when choosing tools. If the task seems blocked by tool limits, explain the limit instead of guessing.');
    return lines.join('\n');
}

export function buildSkillsAwarenessPrompt(skillNames?: string[] | null): string | undefined {
    const normalized = uniqueStrings(skillNames ?? []);
    if (normalized.length === 0) {
        return undefined;
    }

    return [
        '## Available Agent Skills',
        '',
        ...normalized.map((skill) => `- /${skill}`),
        '',
        'Use these skills when they match the current task.',
    ].join('\n');
}

export function composeCodexBaseInstructions(blocks: Array<string | null | undefined>): string | undefined {
    const normalized = blocks
        .map((block) => block?.trim())
        .filter((block): block is string => Boolean(block));

    return normalized.length > 0 ? normalized.join('\n\n') : undefined;
}
