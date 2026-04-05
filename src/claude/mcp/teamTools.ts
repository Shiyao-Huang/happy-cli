/**
 * @module teamTools
 * @description MCP tool registrations for team communication and status.
 *
 * ```mermaid
 * graph LR
 *   A[teamTools] -->|ctx.mcp| B[McpServer]
 *   A -->|ctx.api| C[ApiClient]
 *   A -->|ctx.client| D[ApiSessionClient]
 *   A -->|ctx.triggerHelpLane| E[helpLane]
 *   A -->|ctx.containsHelpMention| F[helpDetect]
 * ```
 *
 * ## Tools registered
 * - send_team_message, get_team_info, list_inactive_team_members, get_team_pulse
 *
 * ## Design
 * - All tools share McpToolContext (see mcpContext.ts)
 * - send_team_message auto-escalates to help-lane when @help is mentioned
 * - get_team_info auto-registers current session if missing from roster
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { DEFAULT_ROLES } from '@/claude/team/roles.config';
import { TaskStateManager } from '../utils/taskStateManager';
import { ensureCurrentSessionRegisteredToTeam } from '../team/ensureTeamMembership';
import { readDaemonState } from '@/persistence';
import { McpToolContext } from './mcpContext';

type TeamRosterMember = {
    sessionId: string;
    roleId?: string;
    role?: string;
    displayName?: string;
    memberId?: string;
    sessionTag?: string;
    runtimeType?: string;
};

type TeamPulseMemberSnapshot = {
    sessionId: string;
    role: string;
    status: string;
    lastSeenMs: number;
    pid?: number;
    runtimeType?: string;
    contextUsedPercent?: number;
};

type ResolvedTeamRosterMember = TeamRosterMember & {
    liveness: 'alive' | 'suspect' | 'inactive' | 'unknown';
    isCollaborating: boolean;
    lastSeenMs: number | null;
    contextUsedPercent: number | null;
};

export function buildTeamRosterView(input: {
    boardMembers: TeamRosterMember[];
    headerSessions: string[];
    pulseMembers: TeamPulseMemberSnapshot[] | null;
    mySessionId: string;
    includeInactive?: boolean;
}): {
    members: ResolvedTeamRosterMember[];
    pulseKnown: boolean;
    activeFilterApplied: boolean;
    counts: {
        totalKnown: number;
        collaborating: number;
        inactive: number;
        unknown: number;
        returned: number;
    };
} {
    const memberMap = new Map<string, TeamRosterMember>();

    for (const member of input.boardMembers) {
        if (!member?.sessionId) continue;
        memberMap.set(member.sessionId, member);
    }

    for (const sessionId of input.headerSessions) {
        if (!sessionId || memberMap.has(sessionId)) continue;
        memberMap.set(sessionId, { sessionId, roleId: '', displayName: sessionId });
    }

    const pulseMembers = input.pulseMembers ?? [];
    const pulseBySession = new Map(pulseMembers.map((member) => [member.sessionId, member]));

    for (const pulseMember of pulseMembers) {
        if (memberMap.has(pulseMember.sessionId)) continue;
        memberMap.set(pulseMember.sessionId, {
            sessionId: pulseMember.sessionId,
            roleId: pulseMember.role,
            displayName: pulseMember.sessionId,
            runtimeType: pulseMember.runtimeType,
        });
    }

    const pulseKnown = input.pulseMembers !== null;
    const allMembers = Array.from(memberMap.values()).map((member) => {
        const pulse = pulseBySession.get(member.sessionId);
        const isSelf = member.sessionId === input.mySessionId;
        const liveness: ResolvedTeamRosterMember['liveness'] = isSelf
            ? 'alive'
            : pulse?.status === 'alive' || pulse?.status === 'suspect'
                ? pulse.status
                : pulseKnown
                    ? 'inactive'
                    : 'unknown';

        return {
            ...member,
            roleId: member.roleId || pulse?.role || '',
            liveness,
            isCollaborating: isSelf || liveness === 'alive' || liveness === 'suspect',
            lastSeenMs: pulse?.lastSeenMs ?? null,
            runtimeType: member.runtimeType || pulse?.runtimeType || undefined,
            contextUsedPercent: pulse?.contextUsedPercent ?? null,
        };
    });

    const counts = {
        totalKnown: allMembers.length,
        collaborating: allMembers.filter((member) => member.isCollaborating).length,
        inactive: allMembers.filter((member) => member.liveness === 'inactive').length,
        unknown: allMembers.filter((member) => member.liveness === 'unknown').length,
        returned: 0,
    };

    const activeFilterApplied = pulseKnown && !input.includeInactive;
    const members = activeFilterApplied
        ? allMembers.filter((member) => member.isCollaborating)
        : allMembers;
    counts.returned = members.length;

    return {
        members,
        pulseKnown,
        activeFilterApplied,
        counts,
    };
}

export function registerTeamTools(ctx: McpToolContext): void {
    const {
        mcp,
        api,
        client,
        parseVoteDecision,
        containsHelpMention,
        toHelpSeverity,
        triggerHelpLane,
    } = ctx;

    const loadArtifactRoster = async (teamId: string) => {
        let boardMembers: TeamRosterMember[] = [];
        let headerSessions: string[] = [];

        try {
            const artifact = await api.getArtifact(teamId);

            let board: any = null;
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                const bodyValue = (artifact.body as { body?: unknown }).body;
                if (typeof bodyValue === 'string') {
                    try {
                        board = JSON.parse(bodyValue);
                    } catch { /* ignore */ }
                } else if (bodyValue && typeof bodyValue === 'object') {
                    board = bodyValue;
                }
            } else {
                board = artifact.body;
            }

            boardMembers = (board && board.team && Array.isArray(board.team.members))
                ? board.team.members
                : [];
            headerSessions = (artifact.header && Array.isArray(artifact.header.sessions))
                ? artifact.header.sessions
                : [];

            logger.debug(`[ahaMCP] team roster: found ${Math.max(boardMembers.length, headerSessions.length)}+ members (board: ${boardMembers.length}, header: ${headerSessions.length})`);
        } catch (e) {
            logger.debug('[ahaMCP] Failed to fetch team artifact:', e);
        }

        return { boardMembers, headerSessions };
    };

    const loadPulseMembers = async (teamId: string): Promise<TeamPulseMemberSnapshot[] | null> => {
        try {
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) return null;

            const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/team-pulse`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId }),
                signal: AbortSignal.timeout(3_000),
            });

            if (!response.ok) return null;
            const pulse = await response.json() as { members?: TeamPulseMemberSnapshot[] };
            return Array.isArray(pulse.members) ? pulse.members : [];
        } catch (e) {
            logger.debug('[ahaMCP] pulse lookup unavailable:', e);
            return null;
        }
    };

    // Team messaging tool
    mcp.registerTool('send_team_message', {
        description: 'Send a message to your team members in the multi-agent collaboration system. Use this to delegate tasks, request updates, or coordinate with other agents.',
        title: 'Send Team Message',
        inputSchema: {
            content: z.string().describe('The message content to send to the team'),
            shortContent: z.string().optional().describe('A short summary of the message (max 150 chars). Recommended for long messages.'),
            mentions: z.array(z.string()).optional().describe('List of session IDs to mention/notify (optional)'),
            type: z.enum(['chat', 'task-update', 'notification', 'vote', 'challenge', 'collaboration-request', 'help-needed', 'handoff']).optional().describe('Message type (default: chat)'),
            priority: z.enum(['normal', 'high', 'urgent']).optional().describe('Message priority (default: normal)'),
            targetSessionId: z.string().optional().describe('Optional target session ID for vote/challenge messages'),
            voteDecision: z.enum(['keep', 'replace', 'unsure']).optional().describe('Optional vote decision metadata for type="vote" messages'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const senderDisplayName = metadata?.displayName || metadata?.name || role || 'unknown-agent';

            if (!teamId) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Error: You are not part of a team. This tool can only be used by agents assigned to a team.',
                    }],
                    isError: true,
                };
            }

            const inferredVoteDecision = (args.type === 'vote' && !args.voteDecision)
                ? parseVoteDecision(args.content)
                : args.voteDecision;
            const messageMetadata = {
                ...(args.priority ? { priority: args.priority } : {}),
                ...(args.targetSessionId ? { targetSessionId: args.targetSessionId } : {}),
                ...(inferredVoteDecision ? { voteDecision: inferredVoteDecision } : {}),
            };
            const message = {
                id: randomUUID(),
                teamId,
                content: args.content,
                shortContent: args.shortContent || (args.content.length > 150 ? args.content.substring(0, 150) + '...' : undefined),
                type: args.type || 'chat',
                timestamp: Date.now(),
                fromSessionId: client.sessionId,
                fromRole: role,
                fromDisplayName: senderDisplayName,
                mentions: args.mentions,
                metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
            };

            await api.sendTeamMessage(teamId, message);

            // Fire-and-forget: notify channel bridge (WeChat/Feishu) if configured.
            // readDaemonState is already imported; daemonPost not needed here — direct fetch is cleaner.
            readDaemonState().then(state => {
              if (!state?.httpPort) return;
              fetch(`http://127.0.0.1:${state.httpPort}/channels/notify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: message }),
                signal: AbortSignal.timeout(3_000),
              }).catch(() => { /* non-fatal */ });
            }).catch(() => { /* non-fatal */ });

            let helpSuffix = '';
            if (role !== 'help-agent' && containsHelpMention(args.content)) {
                const escalation = await triggerHelpLane({
                    teamId,
                    sessionId: client.sessionId,
                    role,
                    type: 'custom',
                    description: args.content,
                    severity: toHelpSeverity(args.priority),
                    sendNotification: false,
                });
                helpSuffix = escalation.helpSpawned
                    ? ' Auto-escalated to a help-agent via @help.'
                    : ' Detected @help and logged/escalated it, but help-agent spawn was not confirmed.';
            }

            return {
                content: [{
                    type: 'text',
                    text: `Successfully sent message to team ${teamId}${args.mentions ? ` (mentioned ${args.mentions.length} members)` : ''}.${helpSuffix}`,
                }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Failed to send team message: ${String(error)}`,
                }],
                isError: true,
            };
        }
    });

    // Team info tool - provides agent with context about their team, role, and collaboration protocols
    mcp.registerTool('get_team_info', {
        description: 'Get an overview of your current team, including your role, active collaborators, role definitions, and collaboration protocols. Inactive roster members are hidden by default.',
        title: 'Get Team Info',
        inputSchema: {},
    }, async () => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const myRole = metadata?.role;
            const mySessionId = client.sessionId;

            if (!teamId) {
                return {
                    content: [{
                        type: 'text',
                        text: 'You are not currently part of a team. This is a solo session.',
                    }],
                    isError: false,
                };
            }

            let { boardMembers, headerSessions } = await loadArtifactRoster(teamId);

            const selfAlreadyPresent = buildTeamRosterView({
                boardMembers,
                headerSessions,
                pulseMembers: null,
                mySessionId,
                includeInactive: true,
            }).members.some((member: any) => {
                if (metadata?.memberId && member?.memberId) {
                    return member.memberId === metadata.memberId
                }
                return member?.sessionId === mySessionId
            })

            if (!selfAlreadyPresent) {
                const membershipResult = await ensureCurrentSessionRegisteredToTeam({
                    api,
                    teamId,
                    sessionId: mySessionId,
                    role: myRole || 'member',
                    metadata,
                    taskStateManager: new TaskStateManager(api, teamId, mySessionId, myRole || 'member'),
                })

                logger.debug(
                    `[ahaMCP] get_team_info self-heal membership: registered=${membershipResult.registered}, alreadyPresent=${membershipResult.alreadyPresent}`
                )

                boardMembers = [
                    ...boardMembers,
                    {
                        ...(metadata?.memberId ? { memberId: metadata.memberId } : {}),
                        sessionId: mySessionId,
                        ...(metadata?.sessionTag ? { sessionTag: metadata.sessionTag } : {}),
                        roleId: myRole || 'member',
                        displayName: metadata?.name || mySessionId,
                        ...(metadata?.flavor ? { runtimeType: metadata.flavor } : {}),
                    },
                ];
                if (!headerSessions.includes(mySessionId)) {
                    headerSessions = [...headerSessions, mySessionId];
                }
            }

            const pulseMembers = await loadPulseMembers(teamId);
            const rosterView = buildTeamRosterView({
                boardMembers,
                headerSessions,
                pulseMembers,
                mySessionId,
                includeInactive: false,
            });

            // Role definitions — from DEFAULT_ROLES fallback (genome is primary)
            const roleDefinitions: Record<string, any> = {};
            for (const [id, def] of Object.entries(DEFAULT_ROLES)) {
                roleDefinitions[id] = {
                    title: def.name,
                    responsibilities: def.responsibilities,
                    boundaries: [],
                };
            }

            // Fallback for unknown roles — use role ID as title so agents see 'implementer' not 'Unassigned'
            if (!roleDefinitions[myRole || '']) {
                roleDefinitions[myRole || ''] = { title: myRole || 'Unassigned', responsibilities: [], boundaries: [] };
            }

            // Collaboration protocols
            const protocols = {
                communication: [
                    'All agents respond to messages from Master',
                    'Workers (Builder/Framer/Reviewer) report status updates to Master',
                    'Use @mentions to direct messages to specific agents',
                    'Mark urgent issues with high/urgent priority'
                ],
                workflow: [
                    'Master receives user request → analyzes → creates plan → assigns tasks',
                    'Workers receive assignment → confirm understanding → execute → report results',
                    'Workers blocked → notify Master → wait for guidance',
                    'Task complete → notify Master → wait for next assignment'
                ],
                handoff: [
                    'Backend complete → Builder notifies Master → Master assigns Framer',
                    'Frontend complete → Framer notifies Master → Master may assign Reviewer',
                    'Always include sufficient context in handoff messages'
                ]
            };

            const teamInfo = {
                myInfo: {
                    sessionId: mySessionId,
                    role: myRole || 'unassigned',
                    roleDefinition: roleDefinitions[myRole || ''] || { title: 'Unassigned', responsibilities: [], boundaries: [] }
                },
                teamMembers: rosterView.members.map(m => {
                    // Members use roleId (from kanban), resolve to role title
                    const roleId = m.roleId || m.role || '';
                    const roleDef = roleDefinitions[roleId];
                    return {
                        sessionId: m.sessionId,
                        role: roleDef?.title || roleId || 'unknown',
                        roleId: roleId,
                        displayName: m.displayName || m.sessionId?.substring(0, 8),
                        liveness: m.liveness,
                        lastSeenMs: m.lastSeenMs,
                        contextUsedPercent: m.contextUsedPercent,
                    };
                }),
                roster: {
                    pulseKnown: rosterView.pulseKnown,
                    activeFilterApplied: rosterView.activeFilterApplied,
                    totalKnown: rosterView.counts.totalKnown,
                    collaborating: rosterView.counts.collaborating,
                    inactive: rosterView.counts.inactive,
                    unknown: rosterView.counts.unknown,
                    returned: rosterView.counts.returned,
                },
                protocols,
                teamId
            };

            const infoText = `
# Team Context Information

## Your Identity
- **Session ID**: ${teamInfo.myInfo.sessionId}
- **Role**: ${teamInfo.myInfo.roleDefinition.title}

## Your Responsibilities
${teamInfo.myInfo.roleDefinition.responsibilities.map((r: string) => `- ${r}`).join('\n')}

## Your Boundaries
${teamInfo.myInfo.roleDefinition.boundaries.map((b: string) => `- ${b}`).join('\n')}

## Team Roster
- **Visible members**: ${teamInfo.roster.returned}
- **Currently collaborating**: ${teamInfo.roster.collaborating}
- **Known inactive**: ${teamInfo.roster.inactive}
- **Liveness known**: ${teamInfo.roster.pulseKnown ? 'yes' : 'no'}
${teamInfo.roster.activeFilterApplied ? '- Inactive roster members are hidden by default. Call `list_inactive_team_members` to inspect dormant/artifact-only entries.' : ''}${!teamInfo.roster.pulseKnown ? '- ⚠ Liveness data unavailable (daemon pulse unreachable). Roster includes ALL known sessions; some may be inactive or dead.' : ''}

## Team Members (${teamInfo.teamMembers.length})
${teamInfo.teamMembers.map((m: any) => {
    const stale = typeof m.lastSeenMs === 'number' ? `, last seen ${Math.round(m.lastSeenMs / 1000)}s ago` : '';
    const ctx = typeof m.contextUsedPercent === 'number' ? `, ctx ${m.contextUsedPercent}%` : '';
    return `- **${m.displayName || m.sessionId.substring(0, 8)}** (${m.role}) [${m.liveness}] - ID: ${m.sessionId}${stale}${ctx}`;
}).join('\n')}

## Communication Protocol
${teamInfo.protocols.communication.map((p: string) => `- ${p}`).join('\n')}

## Workflow Protocol
${teamInfo.protocols.workflow.map((p: string) => `- ${p}`).join('\n')}

## Handoff Protocol
${teamInfo.protocols.handoff.map((p: string) => `- ${p}`).join('\n')}

---
**Team ID**: ${teamInfo.teamId}

Use the \`send_team_message\` tool to communicate with your team members.
`.trim();

            return {
                content: [{
                    type: 'text',
                    text: infoText,
                }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Failed to get team info: ${String(error)}`,
                }],
                isError: true,
            };
        }
    });

    mcp.registerTool('list_inactive_team_members', {
        description: 'List inactive or artifact-only team members hidden from get_team_info by default. Use this for dormant roster detail only when needed.',
        title: 'List Inactive Team Members',
        inputSchema: {},
    }, async () => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            const myRole = metadata?.role;
            const mySessionId = client.sessionId;

            if (!teamId) {
                return {
                    content: [{
                        type: 'text',
                        text: 'You are not currently part of a team. This is a solo session.',
                    }],
                    isError: false,
                };
            }

            let { boardMembers, headerSessions } = await loadArtifactRoster(teamId);
            const selfAlreadyPresent = buildTeamRosterView({
                boardMembers,
                headerSessions,
                pulseMembers: null,
                mySessionId,
                includeInactive: true,
            }).members.some((member: any) => {
                if (metadata?.memberId && member?.memberId) {
                    return member.memberId === metadata.memberId;
                }
                return member?.sessionId === mySessionId;
            });

            if (!selfAlreadyPresent) {
                boardMembers = [
                    ...boardMembers,
                    {
                        ...(metadata?.memberId ? { memberId: metadata.memberId } : {}),
                        sessionId: mySessionId,
                        ...(metadata?.sessionTag ? { sessionTag: metadata.sessionTag } : {}),
                        roleId: myRole || 'member',
                        displayName: metadata?.name || mySessionId,
                        ...(metadata?.flavor ? { runtimeType: metadata.flavor } : {}),
                    },
                ];
                if (!headerSessions.includes(mySessionId)) {
                    headerSessions = [...headerSessions, mySessionId];
                }
            }

            const pulseMembers = await loadPulseMembers(teamId);
            const rosterView = buildTeamRosterView({
                boardMembers,
                headerSessions,
                pulseMembers,
                mySessionId,
                includeInactive: true,
            });

            if (!rosterView.pulseKnown) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Inactive team member detail is unavailable because live pulse truth is not available. Use get_team_info() for the overview until daemon pulse recovers.',
                    }],
                    isError: false,
                };
            }

            const inactiveMembers = rosterView.members.filter((member) => member.liveness === 'inactive');
            if (inactiveMembers.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: `No inactive team members found for team ${teamId}.`,
                    }],
                    isError: false,
                };
            }

            const text = `
# Inactive Team Members

- **Team ID**: ${teamId}
- **Inactive count**: ${inactiveMembers.length}

${inactiveMembers.map((member) => `- **${member.displayName || member.sessionId.substring(0, 8)}** (${member.roleId || member.role || 'unknown'}) [inactive] - ID: ${member.sessionId}`).join('\n')}
            `.trim();

            return {
                content: [{
                    type: 'text',
                    text,
                }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Failed to list inactive team members: ${String(error)}`,
                }],
                isError: true,
            };
        }
    });

    // Team Pulse — real-time liveness of all agents in the team
    mcp.registerTool('get_team_pulse', {
        description: 'Get real-time liveness status of all agents in the team, enriched with assigned-task counts and board distribution. Shows who is alive, suspect (possibly stuck), or dead (no heartbeat). Use this BEFORE reading logs — it tells you which agents need attention. Available to all team members.',
        title: 'Get Team Pulse',
        inputSchema: {
            teamId: z.string().describe('Team ID to check pulse for'),
        },
    }, async (args) => {
        // pingDaemonHeartbeat() now called automatically via registerTool wrapper in index.ts
        if (!/^[a-zA-Z0-9_-]+$/.test(args.teamId)) {
            return { content: [{ type: 'text', text: 'Error: Invalid teamId format.' }], isError: true };
        }
        try {
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) {
                return { content: [{ type: 'text', text: 'Daemon not running.' }], isError: true };
            }
            const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/team-pulse`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: args.teamId }),
                signal: AbortSignal.timeout(5_000),
            });
            const result = await response.json() as {
                teamId: string;
                members: Array<{
                    sessionId: string;
                    role: string;
                    status: string;
                    lastSeenMs: number;
                    pid?: number;
                    runtimeType?: string;
                    contextUsedPercent?: number;
                }>;
                summary: string;
            };
            const tasksResult = await api.listTasks(args.teamId).catch(() => ({ tasks: [], version: 0 }));
            const tasks = Array.isArray(tasksResult.tasks) ? tasksResult.tasks : [];
            const boardStats = {
                todo: 0,
                inProgress: 0,
                review: 0,
                done: 0,
                blocked: 0,
            };
            const taskStatsByAssignee = new Map<string, {
                total: number;
                todo: number;
                inProgress: number;
                review: number;
                done: number;
                blocked: number;
                taskIds: string[];
            }>();

            for (const task of tasks) {
                const status = String(task?.status || 'todo');
                if (status === 'todo') boardStats.todo += 1;
                if (status === 'in-progress') boardStats.inProgress += 1;
                if (status === 'review') boardStats.review += 1;
                if (status === 'done') boardStats.done += 1;
                if (status === 'blocked') boardStats.blocked += 1;

                const assigneeId = typeof task?.assigneeId === 'string' ? task.assigneeId : null;
                if (!assigneeId) continue;

                const entry = taskStatsByAssignee.get(assigneeId) ?? {
                    total: 0,
                    todo: 0,
                    inProgress: 0,
                    review: 0,
                    done: 0,
                    blocked: 0,
                    taskIds: [],
                };

                entry.total += 1;
                if (status === 'todo') entry.todo += 1;
                if (status === 'in-progress') entry.inProgress += 1;
                if (status === 'review') entry.review += 1;
                if (status === 'done') entry.done += 1;
                if (status === 'blocked') entry.blocked += 1;
                if (typeof task?.id === 'string') {
                    entry.taskIds.push(task.id);
                }

                taskStatsByAssignee.set(assigneeId, entry);
            }

            const mySessionId = client.getMetadata()?.ahaSessionId;
            const members = result.members.map((member) => ({
                ...member,
                taskStats: taskStatsByAssignee.get(member.sessionId) ?? {
                    total: 0,
                    todo: 0,
                    inProgress: 0,
                    review: 0,
                    done: 0,
                    blocked: 0,
                    taskIds: [],
                },
            }));
            const formatted = members.map((m) => {
                const isMe = m.sessionId === mySessionId ? ' (YOU)' : '';
                const statusIcon = m.status === 'alive' ? '🟢' : m.status === 'suspect' ? '🟡' : '🔴';
                const staleSec = Math.round(m.lastSeenMs / 1000);
                const taskSummary = m.taskStats.total > 0
                    ? ` tasks=${m.taskStats.total} (todo=${m.taskStats.todo}, in-progress=${m.taskStats.inProgress}, review=${m.taskStats.review}, blocked=${m.taskStats.blocked})`
                    : ' tasks=0';
                const contextSummary = typeof m.contextUsedPercent === 'number'
                    ? ` ctx=${m.contextUsedPercent}%`
                    : '';
                return `${statusIcon} ${m.role}${isMe}: ${m.status} (last seen ${staleSec}s ago) [${m.runtimeType || 'unknown'}]${contextSummary}${taskSummary}`;
            }).join('\n');
            const payload = {
                teamId: result.teamId,
                summary: result.summary,
                boardStats,
                members,
            };
            return {
                content: [{
                    type: 'text',
                    text: `Team Pulse: ${result.summary}\nBoard: todo=${boardStats.todo}, in-progress=${boardStats.inProgress}, review=${boardStats.review}, blocked=${boardStats.blocked}, done=${boardStats.done}\n\n${formatted}\n\n${JSON.stringify(payload, null, 2)}`
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });
}
