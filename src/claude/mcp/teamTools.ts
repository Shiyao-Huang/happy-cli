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
 * - send_team_message, get_team_info, get_team_pulse
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

export function registerTeamTools(ctx: McpToolContext): void {
    const {
        mcp,
        api,
        client,
        pingDaemonHeartbeat,
        parseVoteDecision,
        containsHelpMention,
        toHelpSeverity,
        triggerHelpLane,
    } = ctx;

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
        description: 'Get information about your current team, including your role, team members, role definitions, and collaboration protocols. Essential for understanding how to work with your team.',
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

            // Fetch team artifact to get members
            // Members come from TWO sources (like the mobile kanban app):
            // 1. board.team.members - detailed member info with roleId
            // 2. artifact.header.sessions - session IDs of team members
            let teamMembers: any[] = [];
            try {
                const artifact = await api.getArtifact(teamId);

                // Parse the board body
                let board: any = null;
                if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                    const bodyValue = (artifact.body as { body?: unknown }).body;
                    if (typeof bodyValue === 'string') {
                        try {
                            board = JSON.parse(bodyValue);
                        } catch (e) { /* ignore */ }
                    } else if (bodyValue && typeof bodyValue === 'object') {
                        board = bodyValue;
                    }
                } else {
                    board = artifact.body;
                }

                // Combine members from both sources (like mobile app's roster computation)
                const boardMembers = (board && board.team && Array.isArray(board.team.members))
                    ? board.team.members
                    : [];
                const headerSessions = (artifact.header && Array.isArray(artifact.header.sessions))
                    ? artifact.header.sessions
                    : [];

                // Create a map of existing members from board.team.members
                const memberMap = new Map(boardMembers.map((m: any) => [m.sessionId, m]));

                // Add all session IDs from header (these are the actual team members)
                const allSessionIds = new Set([
                    ...headerSessions,
                    ...boardMembers.map((m: any) => m.sessionId)
                ]);

                // Build the final member list, preferring board member data when available
                teamMembers = Array.from(allSessionIds).map((sessionId: string) => {
                    const existing = memberMap.get(sessionId);
                    return existing || { sessionId, roleId: '', displayName: sessionId };
                });

                logger.debug(`[ahaMCP] get_team_info: Found ${teamMembers.length} members (board: ${boardMembers.length}, header: ${headerSessions.length})`);
            } catch (e) {
                logger.debug('[ahaMCP] Failed to fetch team artifact:', e);
            }

            const selfAlreadyPresent = teamMembers.some((member: any) => {
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

                teamMembers.push({
                    ...(metadata?.memberId ? { memberId: metadata.memberId } : {}),
                    sessionId: mySessionId,
                    ...(metadata?.sessionTag ? { sessionTag: metadata.sessionTag } : {}),
                    roleId: myRole || 'member',
                    displayName: metadata?.name || mySessionId,
                    ...(metadata?.flavor ? { runtimeType: metadata.flavor } : {}),
                })
            }

            // ... (existing imports)

            // ... inside get_team_info ...

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
                teamMembers: teamMembers.map(m => {
                    // Members use roleId (from kanban), resolve to role title
                    const roleId = m.roleId || m.role || '';
                    const roleDef = roleDefinitions[roleId];
                    return {
                        sessionId: m.sessionId,
                        role: roleDef?.title || roleId || 'unknown',
                        roleId: roleId,
                        displayName: m.displayName || m.sessionId?.substring(0, 8)
                    };
                }),
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

## Team Members (${teamInfo.teamMembers.length})
${teamInfo.teamMembers.map((m: any) => `- **${m.displayName || m.sessionId.substring(0, 8)}** (${m.role}) - ID: ${m.sessionId}`).join('\n')}

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

    // Team Pulse — real-time liveness of all agents in the team
    mcp.registerTool('get_team_pulse', {
        description: 'Get real-time liveness status of all agents in the team, enriched with assigned-task counts and board distribution. Shows who is alive, suspect (possibly stuck), or dead (no heartbeat). Use this BEFORE reading logs — it tells you which agents need attention. Available to all team members.',
        title: 'Get Team Pulse',
        inputSchema: {
            teamId: z.string().describe('Team ID to check pulse for'),
        },
    }, async (args) => {
        pingDaemonHeartbeat();
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
