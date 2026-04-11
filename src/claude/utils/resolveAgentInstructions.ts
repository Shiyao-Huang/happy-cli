import type { AgentImage } from '@/api/types/genome';

export type AgentInstructionSource = 'genome' | 'legacy-genome-fallback' | 'ad-hoc-fallback';

export interface ResolveAgentInstructionsOptions {
    agentImage?: AgentImage | null;
    agentImageId?: string | null;
    role?: string;
    promptVars: Record<string, string>;
}

export interface ResolvedAgentInstructions {
    instructions: string;
    source: AgentInstructionSource;
}

export function resolvePromptTemplateVars(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}

function appendPromptSuffix(base: string, suffix?: string): string {
    const trimmedSuffix = suffix?.trim();
    return trimmedSuffix ? `${base}\n\n${trimmedSuffix}` : base;
}

function buildLegacyGenomeFallbackInstructions(role: string | undefined, agentImage?: AgentImage | null): string {
    const resolvedRole = role || agentImage?.teamRole || 'agent';
    const responsibilities = Array.isArray(agentImage?.responsibilities)
        ? agentImage.responsibilities.map((entry) => entry.trim()).filter(Boolean)
        : [];
    const protocol = Array.isArray(agentImage?.protocol)
        ? agentImage.protocol.map((entry) => entry.trim()).filter(Boolean)
        : [];

    const sections = [
        `You are a team agent with role: ${resolvedRole}.`,
        agentImage?.description?.trim() ? `Role summary:\n${agentImage.description.trim()}` : '',
        responsibilities.length > 0
            ? `Core responsibilities:\n${responsibilities.map((entry) => `- ${entry}`).join('\n')}`
            : '',
        protocol.length > 0
            ? `Operating protocol:\n${protocol.map((entry) => `- ${entry}`).join('\n')}`
            : '',
        'Follow your team\'s Kanban board and messaging protocol.',
        'Call `get_team_info` and `list_tasks` to understand your context before acting.',
    ].filter(Boolean);

    return appendPromptSuffix(sections.join('\n\n'), agentImage?.systemPromptSuffix);
}

function buildAdHocFallbackInstructions(role?: string): string {
    return `You are a team agent with role: ${role || 'agent'}. Follow your team's kanban board and messaging protocol. Call \`get_team_info\` and \`list_tasks\` to understand your context.`;
}

export function resolveAgentInstructions({
    agentImage,
    agentImageId,
    role,
    promptVars,
}: ResolveAgentInstructionsOptions): ResolvedAgentInstructions {
    const systemPrompt = agentImage?.systemPrompt?.trim();
    if (systemPrompt) {
        return {
            instructions: appendPromptSuffix(
                resolvePromptTemplateVars(systemPrompt, promptVars),
                agentImage?.systemPromptSuffix,
            ),
            source: 'genome',
        };
    }

    if (agentImageId || agentImage) {
        return {
            instructions: buildLegacyGenomeFallbackInstructions(role, agentImage),
            source: 'legacy-genome-fallback',
        };
    }

    return {
        instructions: buildAdHocFallbackInstructions(role),
        source: 'ad-hoc-fallback',
    };
}
