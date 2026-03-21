import { trimIdent } from '@/utils/trimIdent';

export const HELP_MENTION_RE = /\B@help\b/i;

export function containsHelpMention(content: string | null | undefined): boolean {
    if (typeof content !== 'string') {
        return false;
    }

    const trimmed = content.trim();
    if (!trimmed) {
        return false;
    }

    return HELP_MENTION_RE.test(trimmed);
}

export function toHelpSeverity(priority?: string): 'low' | 'medium' | 'high' | 'critical' {
    switch (priority) {
        case 'urgent':
            return 'critical';
        case 'high':
            return 'high';
        case 'low':
            return 'low';
        default:
            return 'medium';
    }
}

export function getHelpLaneGuidance(): string[] {
    return [
        'Call `request_help` with evidence when you are blocked by environment, ownership, routing, or missing context.',
        'Use `@help` in team chat for the same escalation lane and include what is blocked plus what you already tried.',
    ];
}

export function buildTeamStartupContext(teamId: string, roleId: string): string {
    return trimIdent(`
## Team Context
- Team ID: ${teamId}
- Your role: ${roleId}
- On startup: call get_team_info then list_tasks
- Kanban protocol: start_task before work, complete_task after done
- Help lane: call request_help with evidence, or use @help in team chat for the same escalation path
- Report blockers via send_team_message @master`);
}

export function buildTeamFallbackInstruction(role: string): string {
    return `You are a ${role} in a collaborative team. Coordinate with other agents via the shared Kanban board and keep task statuses accurate. If blocked by environment, ownership, routing, or missing context, call request_help with evidence. @help in team chat triggers the same escalation lane.`;
}

export function buildMissingTeamContextInstruction(): string {
    return trimIdent(`IMPORTANT: You are part of a team but don't have full team context yet.
Before starting any work, you MUST call the get_team_info tool from the "aha" MCP server to:
1. Understand your role and responsibilities
2. See who else is on the team
3. Learn the communication and workflow protocols

If restoring team context fails, call request_help with evidence. @help in team chat triggers the same escalation lane.

Call functions.aha__get_team_info immediately as your first action.`);
}

export function shouldAutoEscalateIncomingHelpMessage(
    message: { content?: string; fromRole?: string; fromSessionId?: string },
    ownSessionId?: string
): boolean {
    if (!containsHelpMention(message.content)) {
        return false;
    }

    if (message.fromRole === 'help-agent') {
        return false;
    }

    if (ownSessionId && message.fromSessionId === ownSessionId) {
        return false;
    }

    return true;
}
