/**
 * Aha MCP server
 * Provides Aha CLI specific tools including chat session title management
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { TEAM_ROLE_LIBRARY } from '@aha/shared-team-config';
import { TaskStateManager } from './taskStateManager';
import { readDaemonState } from '@/persistence';
import {
    canCreateTeamTasks,
    canManageExistingTasks,
    canSpawnAgents
} from '@/claude/team/roles';
import { writeScore } from '@/claude/utils/scoreStorage';
import { aggregateScores } from '@/claude/utils/feedbackPrivacy';
import type { AggregatedFeedback } from '@/claude/utils/feedbackPrivacy';
import { createTeamMemberIdentity } from './teamMemberIdentity';
import { ensureCurrentSessionRegisteredToTeam } from '../team/ensureTeamMembership';
import { readRuntimeLog, resolveTeamRuntimeLogs } from './runtimeLogReader';

export async function startAhaServer(api: any, client: ApiSessionClient, genomeSpecRef?: { current: import('../../api/types/genome').GenomeSpec | null | undefined }) {
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[ahaMCP] Changing title to:', title);
        try {
            // Send title as a summary message, similar to title generator
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });

            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    //
    // Create the MCP server
    //

    // Factory function: creates a fresh MCP server per request.
    // MCP SDK 1.26.0 requires a new transport per request in stateless mode
    // ("Stateless transport cannot be reused across requests").
    const createMcpInstance = () => {

    const mcp = new McpServer({
        name: "Aha MCP",
        version: "1.0.0",
        description: "Aha CLI MCP server with chat session management tools",
    });

    /**
     * Helper: Create TaskStateManager from current client metadata
     * Returns null if not in a team context
     */
    const getTaskStateManager = (): TaskStateManager | null => {
        const metadata = client.getMetadata();
        // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
        const teamId = metadata?.teamId || metadata?.roomId;
        if (!teamId) {
            return null;
        }
        return new TaskStateManager(api, teamId, client.sessionId, metadata?.role);
    };

    //
    // Context Resources (Rules & Preferences)
    //

    // Rules Resource
    mcp.registerResource(
        "aha://context/rules",
        "Global Rules",
        {
            description: "Global rules for the agent",
            mimeType: "text/plain"
        },
        async (uri: { href: string }) => {
            try {
                const result = await api.kvGet('config.rules');
                const rules = result ? result.value : "1. Be concise and efficient.\n2. Verify code before execution.\n3. Prioritize user security.";
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: "text/plain",
                        text: rules
                    }]
                };
            } catch (e) {
                return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Error loading rules." }] };
            }
        }
    );

    // Preferences Resource
    mcp.registerResource(
        "aha://context/preferences",
        "User Preferences",
        {
            description: "User preferences for the agent",
            mimeType: "text/plain"
        },
        async (uri: { href: string }) => {
            try {
                const result = await api.kvGet('config.preferences');
                const prefs = result ? result.value : "Language: English\nRole: Assistant\nStyle: Professional";
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: "text/plain",
                        text: prefs
                    }]
                };
            } catch (e) {
                return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Error loading preferences." }] };
            }
        }
    );

    //
    // Context Management Tools
    //

    mcp.registerTool('update_context', {
        description: 'Update your rules or preferences configuration. Use this to persist user preferences or new rules.',
        title: 'Update Context',
        inputSchema: {
            type: z.enum(['rules', 'preferences']).describe('The type of context to update'),
            content: z.string().describe('The new content for the rules or preferences'),
        },
    }, async (args) => {
        try {
            const key = `config.${args.type}`;
            // Get current version for CAS (Check-And-Set)
            const current = await api.kvGet(key);
            const version = current ? current.version : -1;

            const result = await api.kvMutate([{
                key,
                value: args.content,
                version
            }]);

            if (result.success) {
                return {
                    content: [{ type: 'text', text: `Successfully updated ${args.type}.` }],
                    isError: false,
                };
            } else {
                return {
                    content: [{ type: 'text', text: `Failed to update ${args.type}: ${JSON.stringify(result.errors)}` }],
                    isError: true,
                };
            }
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error updating context: ${String(error)}` }],
                isError: true,
            };
        }
    });

    //
    // Memory Tools (Record & Retrieve)
    //

    // Remember (Save Memory)
    mcp.registerTool('remember', {
        description: 'Save a piece of information to your long-term memory. Use this to store important facts, decisions, or learnings for future reference.',
        title: 'Remember',
        inputSchema: {
            content: z.string().describe('The information to remember'),
            tags: z.array(z.string()).optional().describe('Tags for categorization (e.g., "architecture", "decision", "user-preference")'),
            importance: z.number().min(1).max(5).optional().describe('Importance level (1-5, default 1)'),
        },
    }, async (args) => {
        try {
            const id = randomUUID();
            const timestamp = Date.now();
            // Key format: memory.<timestamp>.<uuid> to allow time-based sorting/listing naturally
            const key = `memory.${timestamp}.${id}`;

            const memory = {
                id,
                content: args.content,
                tags: args.tags || [],
                importance: args.importance || 1,
                timestamp
            };

            const result = await api.kvMutate([{
                key,
                value: JSON.stringify(memory),
                version: -1 // New key
            }]);

            if (result.success) {
                return {
                    content: [{ type: 'text', text: `Memory saved successfully. ID: ${id}` }],
                    isError: false,
                };
            } else {
                return {
                    content: [{ type: 'text', text: `Failed to save memory: ${JSON.stringify(result.errors)}` }],
                    isError: true,
                };
            }
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error saving memory: ${String(error)}` }],
                isError: true,
            };
        }
    });

    // Recall (Search Memory)
    mcp.registerTool('recall', {
        description: 'Search through your long-term memory. Use this to retrieve past decisions, context, or information.',
        title: 'Recall',
        inputSchema: {
            query: z.string().describe('Search query (keywords)'),
            limit: z.number().optional().describe('Max results to return (default 5)'),
            tag: z.string().optional().describe('Filter by specific tag'),
        },
    }, async (args) => {
        try {
            // Fetch recent memories (limit to last 100 for now as a simple implementation)
            // In a real system, this would be a vector search or database query
            const result = await api.kvList('memory.', 100);

            let memories = result.items.map((item: any) => {
                try { return JSON.parse(item.value); } catch { return null; }
            }).filter((m: any) => m !== null);

            // Filter
            const query = args.query.toLowerCase();
            memories = memories.filter((m: any) => {
                const contentMatch = m.content.toLowerCase().includes(query);
                const tagMatch = m.tags.some((t: string) => t.toLowerCase().includes(query));
                const specificTagMatch = args.tag ? m.tags.includes(args.tag) : true;
                return (contentMatch || tagMatch) && specificTagMatch;
            });

            // Sort by importance then recency
            memories.sort((a: any, b: any) => {
                if (b.importance !== a.importance) return b.importance - a.importance;
                return b.timestamp - a.timestamp;
            });

            const limit = args.limit || 5;
            const top = memories.slice(0, limit);

            if (top.length === 0) {
                return {
                    content: [{ type: 'text', text: 'No matching memories found.' }],
                    isError: false,
                };
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(top, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error recalling memory: ${String(error)}` }],
                isError: true,
            };
        }
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[ahaMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    // Team messaging tool
    mcp.registerTool('send_team_message', {
        description: 'Send a message to your team members in the multi-agent collaboration system. Use this to delegate tasks, request updates, or coordinate with other agents.',
        title: 'Send Team Message',
        inputSchema: {
            content: z.string().describe('The message content to send to the team'),
            shortContent: z.string().optional().describe('A short summary of the message (max 150 chars). Recommended for long messages.'),
            mentions: z.array(z.string()).optional().describe('List of session IDs to mention/notify (optional)'),
            type: z.enum(['chat', 'task-update', 'notification']).optional().describe('Message type (default: chat)'),
            priority: z.enum(['normal', 'high', 'urgent']).optional().describe('Message priority (default: normal)'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;

            if (!teamId) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Error: You are not part of a team. This tool can only be used by agents assigned to a team.',
                    }],
                    isError: true,
                };
            }

            const message = {
                id: randomUUID(),
                teamId,
                content: args.content,
                shortContent: args.shortContent || (args.content.length > 150 ? args.content.substring(0, 150) + '...' : undefined),
                type: args.type || 'chat',
                timestamp: Date.now(),
                fromSessionId: client.sessionId,
                fromRole: role,
                mentions: args.mentions,
                metadata: args.priority ? { priority: args.priority } : undefined,
            };

            await api.sendTeamMessage(teamId, message);

            return {
                content: [{
                    type: 'text',
                    text: `Successfully sent message to team ${teamId}${args.mentions ? ` (mentioned ${args.mentions.length} members)` : ''}`,
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

            // Role definitions from shared config
            const roleDefinitions: Record<string, any> = {};
            TEAM_ROLE_LIBRARY.forEach((role: any) => {
                roleDefinitions[role.id] = {
                    title: role.title,
                    responsibilities: role.responsibilities,
                    boundaries: role.abilityBoundaries // Map abilityBoundaries to boundaries
                };
            });

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



    // Task Management Tools
    // Now using Artifacts as the single source of truth to sync with Kanban

    // Create Task - Uses REST API for server-driven task orchestration with WebSocket events
    mcp.registerTool('create_task', {
        description: 'Create a new task for the team. Use this to assign work to team members. Bootstrap/coordinator roles can use this.',
        title: 'Create Task',
        inputSchema: {
            title: z.string().describe('Task title'),
            description: z.string().optional().describe('Detailed task description'),
            assigneeId: z.string().optional().describe('Session ID of the assignee'),
            priority: z.enum(['low', 'medium', 'high']).optional().describe('Task priority (default: medium)'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to create tasks.' }], isError: true };
            }

            if (!canCreateTeamTasks(role)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot create team tasks. Use a coordinator/bootstrap role such as master, orchestrator, or org-manager.`
                    }],
                    isError: true
                };
            }

            // Use REST API - server handles artifact update + WebSocket event emission
            const taskData = {
                title: args.title,
                description: args.description || '',
                status: 'todo' as const,
                assigneeId: args.assigneeId || null,
                reporterId: client.sessionId,
                priority: args.priority || 'medium',
            };

            const result = await api.createTask(teamId, taskData);

            if (!result.success || !result.task) {
                return { content: [{ type: 'text', text: 'Error: Failed to create task via server API.' }], isError: true };
            }

            // Notify Team
            try {
                const notification = {
                    id: randomUUID(),
                    teamId,
                    content: `🆕 **New Task Created**: ${result.task.title}\nAssignee: ${args.assigneeId || 'None'}\nPriority: ${result.task.priority}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: role,
                    mentions: args.assigneeId ? [args.assigneeId] : []
                };
                await api.sendTeamMessage(teamId, notification);
            } catch (e) {
                logger.debug('Failed to send task notification', e);
            }

            return {
                content: [{ type: 'text', text: `Task created successfully. ID: ${result.task.id}` }],
                isError: false,
            };

        } catch (error) {
            return { content: [{ type: 'text', text: `Error creating task: ${String(error)}` }], isError: true };
        }
    });

    // Update Task - Uses REST API for server-driven task orchestration with WebSocket events
    mcp.registerTool('update_task', {
        description: 'Update an existing task\'s status, assignee, or details.',
        title: 'Update Task',
        inputSchema: {
            taskId: z.string().describe('The ID of the task to update'),
            status: z.enum(['todo', 'in-progress', 'review', 'done']).optional().describe('New status'),
            assigneeId: z.string().optional().describe('New assignee Session ID'),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('New priority'),
            comment: z.string().optional().describe('Add a comment/note to the task'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const sessionId = client.sessionId;
            const workerRoles = new Set(['builder', 'framer']);
            const isWorker = workerRoles.has(role || '');
            const isReviewer = role === 'reviewer';

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to update tasks.' }], isError: true };
            }

            if (isReviewer) {
                return { content: [{ type: 'text', text: 'Error: REVIEWER role is read-only and cannot update tasks.' }], isError: true };
            }

            if (args.status === 'in-progress') {
                return {
                    content: [{
                        type: 'text',
                        text: 'Error: Use start_task to acknowledge and begin a task. update_task cannot move a task into in-progress.'
                    }],
                    isError: true
                };
            }

            // First fetch the task to check permissions for workers
            if (isWorker) {
                try {
                    const existingTask = await api.getTask(teamId, args.taskId);
                    if (existingTask) {
                        const assignedToSelf = existingTask.assigneeId === sessionId;
                        const claimingSelf = !existingTask.assigneeId && args.assigneeId === sessionId;

                        if (!assignedToSelf && !claimingSelf) {
                            return {
                                content: [{ type: 'text', text: 'Error: Workers can only update tasks assigned to them.' }],
                                isError: true
                            };
                        }

                        if (args.assigneeId && args.assigneeId !== sessionId) {
                            return {
                                content: [{ type: 'text', text: 'Error: Workers cannot reassign tasks to other members.' }],
                                isError: true
                            };
                        }
                    }
                } catch (e) {
                    // Task not found will be handled by updateTask call
                }
            }

            // Build updates object
            const updates: any = {};
            if (args.status) updates.status = args.status;
            if (args.assigneeId) updates.assigneeId = args.assigneeId;
            if (args.priority) updates.priority = args.priority;

            // Use REST API - server handles artifact update + WebSocket event emission
            const result = await api.updateTask(teamId, args.taskId, updates);

            if (!result.success || !result.task) {
                return { content: [{ type: 'text', text: `Error: Failed to update task via server API.` }], isError: true };
            }

            // Notify Team
            try {
                let updateMsg = `🔄 **Task Updated**: ${result.task.title}`;
                if (args.status) {
                    updateMsg += `\nStatus: → ${args.status}`;
                }
                if (args.assigneeId) {
                    updateMsg += `\nAssignee: ${args.assigneeId}`;
                }
                if (args.priority) {
                    updateMsg += `\nPriority: ${args.priority}`;
                }
                if (args.comment) {
                    updateMsg += `\nComment: ${args.comment}`;
                }

                const notification = {
                    id: randomUUID(),
                    teamId,
                    content: updateMsg,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: role,
                    mentions: args.assigneeId ? [args.assigneeId] : []
                };
                await api.sendTeamMessage(teamId, notification);
            } catch (e) {
                logger.debug('Failed to send task notification', e);
            }

            return {
                content: [{ type: 'text', text: `Task ${args.taskId} updated successfully.` }],
                isError: false,
            };

        } catch (error) {
            return { content: [{ type: 'text', text: `Error updating task: ${String(error)}` }], isError: true };
        }
    });

    // Delete Task - Uses REST API for server-driven task orchestration with WebSocket events
    mcp.registerTool('delete_task', {
        description: 'Delete a task from the team board. Coordinator roles can delete tasks.',
        title: 'Delete Task',
        inputSchema: {
            taskId: z.string().describe('The ID of the task to delete'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to delete tasks.' }], isError: true };
            }

            if (!canManageExistingTasks(role)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot delete tasks. Ask a coordinator role to handle this.`
                    }],
                    isError: true
                };
            }

            // Use REST API - server handles artifact update + WebSocket event emission
            const result = await api.deleteTask(teamId, args.taskId);

            if (!result.success) {
                return { content: [{ type: 'text', text: 'Error: Failed to delete task via server API.' }], isError: true };
            }

            // Notify Team
            try {
                const notification = {
                    id: randomUUID(),
                    teamId,
                    content: `🗑️ **Task Deleted**: ${args.taskId}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: role,
                };
                await api.sendTeamMessage(teamId, notification);
            } catch (e) {
                logger.debug('Failed to send task deletion notification', e);
            }

            return {
                content: [{ type: 'text', text: `Task ${args.taskId} deleted successfully.` }],
                isError: false,
            };

        } catch (error) {
            return { content: [{ type: 'text', text: `Error deleting task: ${String(error)}` }], isError: true };
        }
    });

    // List Tasks - Uses TaskStateManager for role-based filtering
    mcp.registerTool('list_tasks', {
        description: 'List tasks for the current team. Returns role-filtered context including your assigned tasks, available tasks, and team stats.',
        title: 'List Tasks',
        inputSchema: {
            status: z.enum(['todo', 'in-progress', 'review', 'done', 'blocked']).optional().describe('Filter by status'),
            showAll: z.boolean().optional().describe('If true, shows all tasks (for coordinators only). Default shows role-filtered context.'),
        },
    }, async (args) => {
        try {
            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to list tasks.' }], isError: true };
            }

            const metadata = client.getMetadata();
            const isCoordinator = ['master', 'orchestrator', 'team-lead'].includes(metadata?.role || '');

            // Get role-filtered context via TaskStateManager
            const kanbanContext = await taskManager.getFilteredContext();

            // Format output based on role and args
            let output: any;
            if (args.showAll && isCoordinator) {
                // Coordinators can see all tasks
                const board = await taskManager.getBoard();
                let tasks = board.tasks || [];
                if (args.status) {
                    tasks = tasks.filter((t: any) => t.status === args.status);
                }
                output = {
                    allTasks: tasks,
                    teamStats: kanbanContext.teamStats,
                    pendingApprovals: kanbanContext.pendingApprovals
                };
            } else {
                // Role-filtered context
                let myTasks = kanbanContext.myTasks;
                let availableTasks = kanbanContext.availableTasks;
                if (args.status) {
                    myTasks = myTasks.filter((t: any) => t.status === args.status);
                    availableTasks = availableTasks.filter((t: any) => t.status === args.status);
                }
                output = {
                    myTasks,
                    availableTasks,
                    teamStats: kanbanContext.teamStats,
                    ...(kanbanContext.pendingApprovals ? { pendingApprovals: kanbanContext.pendingApprovals } : {})
                };
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error listing tasks: ${String(error)}` }], isError: true };
        }
    });

    // ========== 嵌套任务工具 (v2) ==========

    // Create Subtask - Uses REST API for server-driven task orchestration with WebSocket events
    mcp.registerTool('create_subtask', {
        description: 'Create a subtask under an existing task. Use this to break down complex tasks into smaller, manageable pieces. Coordinator roles can create subtasks.',
        title: 'Create Subtask',
        inputSchema: {
            parentTaskId: z.string().describe('ID of the parent task'),
            title: z.string().describe('Subtask title'),
            description: z.string().optional().describe('Detailed subtask description'),
            assigneeId: z.string().optional().describe('Session ID of the assignee (inherits from parent if not specified)'),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Subtask priority (inherits from parent if not specified)'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to create subtasks.' }], isError: true };
            }

            if (!canManageExistingTasks(role)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot create subtasks. Ask a coordinator role to handle this.`
                    }],
                    isError: true
                };
            }

            // Get parent task to inherit properties
            let parentTask: any = null;
            try {
                parentTask = await api.getTask(teamId, args.parentTaskId);
            } catch (e) {
                return { content: [{ type: 'text', text: `Error: Parent task ${args.parentTaskId} not found.` }], isError: true };
            }

            if (!parentTask) {
                return { content: [{ type: 'text', text: `Error: Parent task ${args.parentTaskId} not found.` }], isError: true };
            }

            // Use REST API - server handles artifact update + WebSocket event emission
            const subtaskData = {
                title: args.title,
                description: args.description || '',
                status: 'todo' as const,
                assigneeId: args.assigneeId ?? parentTask.assigneeId ?? null,
                reporterId: client.sessionId,
                priority: args.priority ?? parentTask.priority ?? 'medium',
                parentTaskId: args.parentTaskId,
            };

            const result = await api.createTask(teamId, subtaskData);

            if (!result.success || !result.task) {
                return { content: [{ type: 'text', text: 'Error: Failed to create subtask via server API.' }], isError: true };
            }

            // Notify team
            try {
                await api.sendTeamMessage(teamId, {
                    id: randomUUID(),
                    teamId,
                    content: `📌 Subtask created under "${parentTask.title}":\n• ${result.task.title}\nAssignee: ${result.task.assigneeId || 'Unassigned'}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: role,
                    mentions: result.task.assigneeId ? [result.task.assigneeId] : []
                });
            } catch (e) { logger.debug('Failed to send subtask notification', e); }

            return {
                content: [{ type: 'text', text: `Subtask created successfully.\nID: ${result.task.id}\nParent: ${parentTask.title}` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error creating subtask: ${String(error)}` }], isError: true };
        }
    });

    // List Subtasks - 列出子任务
    mcp.registerTool('list_subtasks', {
        description: 'List all subtasks of a given task.',
        title: 'List Subtasks',
        inputSchema: {
            parentTaskId: z.string().describe('ID of the parent task'),
            includeNested: z.boolean().optional().describe('Include deeply nested subtasks (default: false)'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                // Artifact doesn't exist - try to create it (lazy initialization)
                logger.debug(`[MCP] Team artifact ${teamId} not found, attempting lazy initialization...`);
                try {
                    const initialHeader = {
                        type: 'team',
                        name: `Team ${teamId.substring(0, 8)}`,
                        createdAt: Date.now()
                    };
                    const initialBody = {
                        tasks: [],
                        columns: [
                            { id: 'todo', title: 'To Do', order: 0 },
                            { id: 'in-progress', title: 'In Progress', order: 1 },
                            { id: 'review', title: 'Review', order: 2 },
                            { id: 'done', title: 'Done', order: 3 }
                        ],
                        members: [],
                        createdAt: Date.now()
                    };
                    artifact = await api.createArtifact(teamId, initialHeader, initialBody);
                    logger.debug(`[MCP] Successfully created team artifact ${teamId}`);

                    // Verify artifact body is correctly initialized
                    try {
                        logger.debug(`[MCP] Verifying team artifact ${teamId} body initialization...`);
                        const verificationArtifact = await api.getArtifact(teamId);

                        if (!verificationArtifact.body) {
                            throw new Error(
                                `Team artifact created but body not initialized. ` +
                                `This may indicate a server-side initialization issue. ` +
                                `Please try again or contact support.`
                            );
                        }

                        // Try to parse the body to ensure it's valid
                        let bodyValid = false;
                        if (typeof verificationArtifact.body === 'string') {
                            try {
                                JSON.parse(verificationArtifact.body);
                                bodyValid = true;
                            } catch {
                                // Body is a string but not valid JSON
                            }
                        } else if (typeof verificationArtifact.body === 'object') {
                            bodyValid = true;
                        }

                        if (!bodyValid) {
                            throw new Error(
                                `Team artifact body is malformed. ` +
                                `Expected valid JSON structure but got: ${typeof verificationArtifact.body}`
                            );
                        }

                        logger.debug(`[MCP] Team artifact ${teamId} body verified successfully`);
                        artifact = verificationArtifact; // Use the verified artifact

                    } catch (verifyError) {
                        logger.debug(`[MCP] Team artifact ${teamId} verification failed:`, verifyError);
                        // Clean up the potentially broken artifact
                        try {
                            // Note: We don't have a delete artifact API yet, so we just log
                            logger.debug(`[MCP] Team artifact ${teamId} may need manual cleanup`);
                        } catch {
                            // Ignore cleanup errors
                        }
                        throw new Error(
                            `Team artifact verification failed: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`
                        );
                    }

                } catch (createError) {
                    logger.debug(`[MCP] Failed to create team artifact ${teamId}:`, createError);
                    return { content: [{ type: 'text', text: `Error: ${createError instanceof Error ? createError.message : 'Failed to fetch or create team artifact.'}` }], isError: true };
                }
            }

            let board: any = { tasks: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                const bodyValue = (artifact.body as { body?: unknown }).body;
                if (typeof bodyValue === 'string') {
                    try { board = JSON.parse(bodyValue); } catch (e) { /* ignore */ }
                } else if (bodyValue && typeof bodyValue === 'object') {
                    board = bodyValue;
                }
            } else if (artifact.body) {
                board = artifact.body;
            }

            const parentTask = board.tasks?.find((t: any) => t.id === args.parentTaskId);
            if (!parentTask) {
                return { content: [{ type: 'text', text: `Task ${args.parentTaskId} not found.` }], isError: true };
            }

            let subtasks: any[] = [];
            if (args.includeNested) {
                // Recursively collect all subtasks
                const collectSubtasks = (taskId: string) => {
                    const task = board.tasks.find((t: any) => t.id === taskId);
                    if (!task) return;
                    task.subtaskIds?.forEach((stid: string) => {
                        const st = board.tasks.find((t: any) => t.id === stid);
                        if (st) {
                            subtasks.push(st);
                            collectSubtasks(stid);
                        }
                    });
                };
                collectSubtasks(args.parentTaskId);
            } else {
                // Direct children only
                subtasks = board.tasks.filter((t: any) => parentTask.subtaskIds?.includes(t.id));
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(subtasks, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error listing subtasks: ${String(error)}` }], isError: true };
        }
    });

    // Start Task - Uses TaskStateManager for execution link management and state broadcasting
    mcp.registerTool('start_task', {
        description: 'Mark a task as actively being worked on by you. Creates an execution link between your session and the task.',
        title: 'Start Task',
        inputSchema: {
            taskId: z.string().describe('ID of the task to start'),
        },
    }, async (args) => {
        try {
            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            // Delegate to TaskStateManager which handles:
            // - Execution link creation
            // - Status change to 'in-progress'
            // - State change broadcasting
            // - Team message notification
            const result = await taskManager.startTask(args.taskId);

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            // Get task details for response
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            return {
                content: [{ type: 'text', text: `Started working on: "${taskTitle}"\nStatus: in-progress` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error starting task: ${String(error)}` }], isError: true };
        }
    });

    // Complete Task - Uses TaskStateManager for status propagation and state broadcasting
    mcp.registerTool('complete_task', {
        description: 'Mark a task as complete. If all subtasks of a parent are done, the parent will automatically move to review.',
        title: 'Complete Task',
        inputSchema: {
            taskId: z.string().describe('ID of the task to complete'),
        },
    }, async (args) => {
        try {
            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            // Get task details for response message
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            // Delegate to TaskStateManager which handles:
            // - Incomplete subtask validation
            // - Execution link status update
            // - Status propagation to parent tasks
            // - State change broadcasting
            // - Team message notification
            const result = await taskManager.completeTask(args.taskId);

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            const propagatedCount = result.propagatedTasks?.length ? result.propagatedTasks.length - 1 : 0;

            return {
                content: [{ type: 'text', text: `Task "${taskTitle}" completed.\nPropagated to ${propagatedCount} parent task(s).` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error completing task: ${String(error)}` }], isError: true };
        }
    });

    // Report Blocker - Uses TaskStateManager for blocker tracking and state broadcasting
    mcp.registerTool('report_blocker', {
        description: 'Report a blocker on a task. This will mark the task as blocked and notify the Master.',
        title: 'Report Blocker',
        inputSchema: {
            taskId: z.string().describe('ID of the blocked task'),
            type: z.enum(['dependency', 'question', 'resource', 'technical']).describe('Type of blocker'),
            description: z.string().describe('Detailed description of the blocker'),
        },
    }, async (args) => {
        try {
            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            // Get task details for response message
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            // Delegate to TaskStateManager which handles:
            // - Blocker creation with UUID
            // - Status change to 'blocked'
            // - hasBlockedChild propagation to parents
            // - State change broadcasting
            // - Team message notification (help-needed type)
            const result = await taskManager.reportBlocker(
                args.taskId,
                args.type,
                args.description
            );

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            return {
                content: [{ type: 'text', text: `Blocker reported on "${taskTitle}".\nBlocker ID: ${result.blockerId}\nMaster has been notified.` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error reporting blocker: ${String(error)}` }], isError: true };
        }
    });

    // Resolve Blocker - Uses TaskStateManager for blocker resolution and state broadcasting
    mcp.registerTool('resolve_blocker', {
        description: 'Resolve a blocker on a task. Coordinator roles can resolve blockers.',
        title: 'Resolve Blocker',
        inputSchema: {
            taskId: z.string().describe('ID of the task with the blocker'),
            blockerId: z.string().describe('ID of the blocker to resolve'),
            resolution: z.string().describe('How the blocker was resolved'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const role = metadata?.role;

            if (!canManageExistingTasks(role)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot resolve blockers. Ask a coordinator role to handle this.`
                    }],
                    isError: true
                };
            }

            const taskManager = getTaskStateManager();
            if (!taskManager) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            // Get task details for response message
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            // Delegate to TaskStateManager which handles:
            // - Blocker resolution timestamp
            // - Status change back to 'in-progress' if no more blockers
            // - Parent hasBlockedChild flag update
            // - State change broadcasting
            // - Team message notification
            const result = await taskManager.resolveBlocker(
                args.taskId,
                args.blockerId,
                args.resolution
            );

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            // Get updated task status
            const updatedBoard = await taskManager.getBoard();
            const updatedTask = updatedBoard.tasks?.find((t: any) => t.id === args.taskId);
            const newStatus = updatedTask?.status || 'in-progress';

            return {
                content: [{ type: 'text', text: `Blocker resolved on "${taskTitle}".\nTask status: ${newStatus}` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error resolving blocker: ${String(error)}` }], isError: true };
        }
    });

    // ========== End 嵌套任务工具 ==========

    // ========== Agent Spawning Tools ==========

    // List Available Agents — browse genome marketplace before create_agent
    mcp.registerTool('list_available_agents', {
        description: [
            'Browse the genome marketplace to find available agent types before spawning.',
            'Returns agents with their IDs, descriptions, ratings, spawn counts, and tags.',
            'Use this BEFORE create_agent to pick the best fit or decide to fork one.',
            'Org-manager and coordinator roles only.',
        ].join(' '),
        title: 'List Available Agents',
        inputSchema: {
            query: z.string().optional().describe('Search query — filter by name, description, or tags'),
            category: z.string().optional().describe("Filter by category: 'coordination' | 'implementation' | 'quality' | 'research' | 'support'"),
            namespace: z.string().optional().describe("Filter by namespace, e.g. '@official'. Omit to search all public agents."),
            limit: z.number().default(10).describe('Max results to return'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (!canSpawnAgents(role)) {
            return { content: [{ type: 'text', text: 'Error: Only org-manager and coordinator roles can browse the agent marketplace.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
        try {
            const qs = new URLSearchParams();
            if (args.query) qs.set('q', args.query);
            if (args.category) qs.set('category', args.category);
            if (args.namespace) qs.set('namespace', args.namespace);
            qs.set('limit', String(args.limit ?? 10));

            const res = await fetch(`${hubUrl}/genomes?${qs}`, { signal: AbortSignal.timeout(5_000) });
            if (!res.ok) throw new Error(`hub returned ${res.status}`);
            const data = await res.json() as { genomes: Array<{
                id: string; namespace: string | null; name: string; version: number;
                description: string | null; tags: string | null; category: string | null;
                spawnCount: number; feedbackData: string | null;
            }> };

            const results = (data.genomes ?? [])
                .filter(g => g.category !== 'corps')
                .slice(0, args.limit ?? 10)
                .map(g => {
                    let fb: { avgScore?: number; evaluationCount?: number; latestAction?: string } = {};
                    try { fb = g.feedbackData ? JSON.parse(g.feedbackData) : {}; } catch { /* */ }
                    const tags = g.tags ? (() => { try { return JSON.parse(g.tags!); } catch { return []; } })() : [];
                    return {
                        id: g.id,
                        ref: `${g.namespace ?? '@public'}/${g.name}@v${g.version}`,
                        description: g.description ?? '(no description)',
                        category: g.category ?? 'unknown',
                        tags,
                        spawnCount: g.spawnCount,
                        avgScore: fb.avgScore ?? null,
                        evaluationCount: fb.evaluationCount ?? 0,
                        latestAction: fb.latestAction ?? null,
                    };
                });

            const text = results.length === 0
                ? 'No agents found matching the query.'
                : results.map(r => [
                    `• ${r.ref} [id: ${r.id}]`,
                    `  ${r.description}`,
                    `  category: ${r.category} | tags: ${r.tags.join(', ')}`,
                    `  spawned: ${r.spawnCount}x | rating: ${r.avgScore !== null ? `${r.avgScore}/100 (${r.evaluationCount} evals)` : 'not yet rated'}`,
                    r.latestAction ? `  last supervisor action: ${r.latestAction}` : '',
                ].filter(Boolean).join('\n')).join('\n\n');

            return { content: [{ type: 'text', text: text }], isError: false };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error querying genome hub: ${String(error)}` }], isError: true };
        }
    });

    // Create Agent - Spawns a new agent session via the daemon
    mcp.registerTool('create_agent', {
        description: `Spawn a new AI agent and register it to the team. The agent starts immediately and can communicate with the team.

## When to Create Agents

- You need capabilities your current role doesn't have (e.g., you're a master and need implementers)
- The task requires parallel work that one agent can't do alone
- A specialized role (qa-engineer, architect, researcher) would improve quality

## Decision Framework

1. **Analyze the task** — What work needs to be done? What skills are required?
2. **Check existing roster** — Call get_team_info first. Don't duplicate roles that already exist.
3. **Minimum viable team** — Spawn the fewest agents that can accomplish the goal. Over-staffing wastes resources.
4. **Role selection guide:**
   - master: Coordinator. Spawn FIRST if no coordinator exists. Breaks down tasks, assigns work, monitors progress.
   - implementer: Code writer. The primary worker. Spawn 1-2 for most tasks.
   - architect: System designer. Spawn only for complex architectural decisions.
   - qa-engineer: Tester. Spawn when quality assurance is explicitly needed.
   - researcher: Information gatherer. Spawn when external research or analysis is required.
   - reviewer: Code reviewer. Spawn for review-heavy workflows.

## Agent Type Selection

- \`agent: "claude"\` — Default. Full Claude Code with MCP tools, file editing, terminal access. Best for most tasks.
- \`agent: "codex"\` — OpenAI Codex. Use only when explicitly requested by user.
- Rule: Default to claude. Only use codex when user says "codex", "openai", or "mixed mode".

## Prompt Engineering for Spawned Agents

The \`prompt\` field is injected as the agent's initial task context. Write it as a clear, actionable instruction:
- BAD: "You are an implementer" (too vague, agent already knows its role)
- GOOD: "Implement the iOS subscription paywall UI using SwiftUI. The design specs are in docs/paywall-spec.md. Focus on the purchase flow first."

## Anti-Patterns

- Don't spawn agents for tasks you can do yourself
- Don't spawn more than 4 agents without explicit user approval
- Don't spawn agents without checking get_team_info first
- Don't use codex unless user explicitly requested it`,
        title: 'Create Agent',
        inputSchema: {
            role: z.string().describe('Role ID: master, implementer, architect, qa-engineer, researcher, reviewer, builder, observer, etc.'),
            teamId: z.string().describe('Team ID to register the new agent to'),
            directory: z.string().describe('Working directory (repository root) for the new agent'),
            sessionName: z.string().optional().describe('Human-readable display name, e.g. "Frontend Implementer"'),
            prompt: z.string().optional().describe('Task-specific instructions for the agent. Be concrete — what exactly should this agent work on?'),
            model: z.string().optional().describe('Model override. Omit to use system default.'),
            agent: z.enum(['claude', 'codex']).default('claude').describe('Runtime: claude (default, recommended) or codex (only when user explicitly requests)'),
            executionPlane: z.enum(['mainline', 'bypass']).default('mainline').describe('Execution plane. Agents can only create mainline agents.'),
            specId: z.string().optional().describe('Optional spec/role-definition ID to pass to the spawned agent via AHA_SPEC_ID env var.'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const role = metadata?.role;

            // Genome spec is authoritative: behavior.canSpawnAgents overrides hardcode.
            const genomeAllows = genomeSpecRef?.current?.behavior?.canSpawnAgents;
            const allowed = genomeAllows !== undefined ? genomeAllows : canSpawnAgents(role);
            if (!allowed) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Role "${role || 'unknown'}" cannot create agents. Only bootstrap/coordinator roles may spawn team members.`
                    }],
                    isError: true,
                };
            }

            // Generate and carry member identity as a pair so create_agent
            // cannot regress into a partial refactor where sessionTag is used
            // before it exists.
            const { memberId, sessionTag } = createTeamMemberIdentity(args.teamId);

            // Security constraint: agents cannot create bypass sessions
            if (args.executionPlane === 'bypass') {
                return {
                    content: [{ type: 'text', text: 'Error: Agents cannot create bypass sessions. Only the system (hook router) can create bypass agents. This is the mainline-cannot-create-bypass constraint.' }],
                    isError: true,
                };
            }

            // Read daemon state to get the control port
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) {
                return {
                    content: [{ type: 'text', text: 'Error: Daemon is not running. Cannot spawn agent sessions without a running daemon.' }],
                    isError: true,
                };
            }
            const parentSessionId = client.sessionId;

            const spawnBody = {
                directory: args.directory,
                sessionTag,
                sessionName: args.sessionName || `${args.role}-agent`,
                role: args.role,
                teamId: args.teamId,
                agent: args.agent || 'claude',
                parentSessionId,
                executionPlane: args.executionPlane || 'mainline',
                env: {
                    AHA_AGENT_LANGUAGE: process.env.AHA_AGENT_LANGUAGE || 'en',
                    AHA_TEAM_MEMBER_ID: memberId,
                    ...(args.prompt ? { AHA_AGENT_PROMPT: args.prompt } : {}),
                    ...(args.model ? { AHA_AGENT_MODEL: args.model } : {}),
                },
            } as Record<string, any>;

            // Auto-resolve specId from genome-hub: explicit arg > @official/{role} > none
            let resolvedSpecId = args.specId;
            if (!resolvedSpecId) {
                try {
                    const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
                    const res = await fetch(
                        `${hubUrl}/genomes/%40official/${encodeURIComponent(args.role)}`,
                        { signal: AbortSignal.timeout(3_000) }
                    );
                    if (res.ok) {
                        const data = await res.json() as { genome?: { id: string } };
                        resolvedSpecId = data.genome?.id;
                        if (resolvedSpecId) {
                            logger.debug(`[create_agent] Auto-resolved specId=${resolvedSpecId} for role ${args.role}`);
                        }
                    }
                } catch {
                    // genome-hub unreachable — proceed without specId
                }
            }
            if (resolvedSpecId) {
                spawnBody.specId = resolvedSpecId;
                // Fire-and-forget: increment spawn count in genome-hub
                const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
                fetch(`${hubUrl}/genomes/id/${encodeURIComponent(resolvedSpecId)}/spawn`, {
                    method: 'POST',
                    signal: AbortSignal.timeout(3_000),
                }).catch(() => { /* non-critical */ });
            }

            const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/spawn-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(spawnBody),
                signal: AbortSignal.timeout(15_000),
            });

            const result = await response.json() as { success?: boolean; sessionId?: string; error?: string };

            if (!response.ok || !result.success) {
                return {
                    content: [{ type: 'text', text: `Error spawning agent: ${result.error || `HTTP ${response.status}`}` }],
                    isError: true,
                };
            }

            // Register spawned agent as a team member
            const spawnedSessionId = result.sessionId;
            if (spawnedSessionId && args.teamId) {
                try {
                    await api.addTeamMember(
                        args.teamId,
                        spawnedSessionId,
                        args.role,
                        args.sessionName || `${args.role}-agent`,
                        {
                            memberId,
                            sessionTag,
                            specId: resolvedSpecId,
                            parentSessionId,
                            executionPlane: args.executionPlane || 'mainline',
                            runtimeType: args.agent || 'claude',
                        }
                    );
                    logger.debug(`[create_agent] Added ${args.role} (${spawnedSessionId}) to team ${args.teamId}`);
                } catch (memberError) {
                    logger.debug(`[create_agent] Warning: Failed to add to team roster: ${memberError}`);
                    // Don't fail the whole operation — agent is spawned, just not in roster yet
                }
            }

            return {
                content: [{ type: 'text', text: JSON.stringify({ sessionId: spawnedSessionId, memberId, sessionTag, role: args.role, teamId: args.teamId, status: 'spawned_and_registered' }) }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error creating agent: ${String(error)}` }],
                isError: true,
            };
        }
    });

    // List Team Agents - Lists current team members/agents
    mcp.registerTool('list_team_agents', {
        description: 'List all agents currently in the team, including their roles, session IDs, and status.',
        title: 'List Team Agents',
        inputSchema: {},
    }, async () => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;

            if (!teamId) {
                return {
                    content: [{ type: 'text', text: 'Error: You are not part of a team.' }],
                    isError: true,
                };
            }

            // Fetch team artifact to get members (same pattern as get_team_info)
            const artifact = await api.getArtifact(teamId);

            let board: any = null;
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                const bodyValue = (artifact.body as { body?: unknown }).body;
                if (typeof bodyValue === 'string') {
                    try { board = JSON.parse(bodyValue); } catch (e) { /* ignore */ }
                } else if (bodyValue && typeof bodyValue === 'object') {
                    board = bodyValue;
                }
            } else {
                board = artifact.body;
            }

            const boardMembers = (board && board.team && Array.isArray(board.team.members))
                ? board.team.members
                : [];
            const headerSessions = (artifact.header && Array.isArray(artifact.header.sessions))
                ? artifact.header.sessions
                : [];

            const memberMap = new Map(boardMembers.map((m: any) => [m.sessionId, m]));
            const allSessionIds = new Set([
                ...headerSessions,
                ...boardMembers.map((m: any) => m.sessionId)
            ]);

            // Role definitions from shared config
            const roleDefinitions: Record<string, any> = {};
            TEAM_ROLE_LIBRARY.forEach((role: any) => {
                roleDefinitions[role.id] = { title: role.title };
            });

            const BYPASS_ROLE_IDS = ['supervisor', 'help-agent'];
            const agents = Array.from(allSessionIds).map((sessionId: string) => {
                const member = memberMap.get(sessionId) as Record<string, any> | undefined;
                const roleId = member?.roleId || member?.role || '';
                const roleDef = roleDefinitions[roleId];
                return {
                    sessionId,
                    role: roleDef?.title || roleId || 'unknown',
                    roleId,
                    displayName: member?.displayName || sessionId?.substring(0, 8),
                    specId: member?.specId || null,
                    executionPlane: member?.executionPlane ||
                        (BYPASS_ROLE_IDS.includes(roleId) ? 'bypass' : 'mainline'),
                    runtimeType: member?.runtimeType || 'claude',
                };
            });

            return {
                content: [{ type: 'text', text: JSON.stringify({ teamId, agents, count: agents.length }, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error listing team agents: ${String(error)}` }],
                isError: true,
            };
        }
    });

    // ========== Supervisor-Only Tools ==========

    mcp.registerTool('update_agent_model', {
        description: 'Override the model for a running agent session. Supervisor/master can use this to switch any agent\'s model. Takes effect the next time the agent session is started/restarted.',
        title: 'Update Agent Model',
        inputSchema: {
            sessionId: z.string().describe('Session ID of the agent to update'),
            modelId: z.string().describe('New model to use (e.g. claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5)'),
            fallbackModelId: z.string().optional().describe('Fallback model if primary is unavailable'),
        },
    }, async (args) => {
        const metadata = client.getMetadata();
        const role = metadata?.role;
        if (role !== 'supervisor' && role !== 'master') {
            return {
                content: [{ type: 'text', text: `Error: Role '${role}' cannot update agent models. Only supervisor/master can use this tool.` }],
                isError: true,
            };
        }
        try {
            const session = await api.getSession(args.sessionId);
            if (!session) {
                return { content: [{ type: 'text', text: `Error: Session ${args.sessionId} not found.` }], isError: true };
            }
            const nextMetadata = {
                ...session.metadata,
                modelOverride: args.modelId,
                ...(args.fallbackModelId ? { fallbackModelOverride: args.fallbackModelId } : {}),
            };
            await api.updateSessionMetadata(args.sessionId, nextMetadata, session.metadataVersion);
            const msg = args.fallbackModelId
                ? `Model updated for ${args.sessionId}: ${args.modelId} (fallback: ${args.fallbackModelId})`
                : `Model updated for ${args.sessionId}: ${args.modelId}`;
            return { content: [{ type: 'text', text: msg }], isError: false };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error updating agent model: ${String(error)}` }],
                isError: true,
            };
        }
    });

    mcp.registerTool('read_team_log', {
        description: 'Read the team message log. Returns messages since the last supervisor run (cursor-based, incremental). Pass fromCursor=0 to read all. Supervisor/help-agent only.',
        title: 'Read Team Log',
        inputSchema: {
            teamId: z.string().describe('Team ID to read logs for'),
            limit: z.number().default(100).describe('Max messages to return'),
            fromCursor: z.number().default(-1).describe('Line index to read from. -1 = use env AHA_SUPERVISOR_TEAM_LOG_CURSOR (auto-incremental). 0 = read all.'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can read team logs.' }], isError: true };
        }
        try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const localPath = path.join(process.cwd(), '.aha', 'teams', args.teamId, 'messages.jsonl');

            const cursor = args.fromCursor >= 0
                ? args.fromCursor
                : parseInt(process.env.AHA_SUPERVISOR_TEAM_LOG_CURSOR || '0');

            if (fs.existsSync(localPath)) {
                const lines = fs.readFileSync(localPath, 'utf-8').split('\n').filter(Boolean);
                const newLines = lines.slice(cursor, cursor + args.limit);
                const newCursor = cursor + newLines.length;
                const hasNew = newLines.length > 0;

                // ── Rotation fallback ────────────────────────────────────────────
                // When cursor >= totalLines AND file is at/near MAX_RECENT_MESSAGES (500),
                // the file was rotated (oldest lines dropped, cursor still at old end).
                // Fall back to server API to detect truly new messages.
                if (!hasNew && lines.length >= 490) {
                    try {
                        // Use timestamp of the most recent local message as anchor
                        const lastLocalMsg = lines.length > 0
                            ? (() => { try { return JSON.parse(lines[lines.length - 1]); } catch { return null; } })()
                            : null;
                        const afterTs = lastLocalMsg?.timestamp ?? 0;

                        const serverResult = await api.getTeamMessages(args.teamId, { limit: args.limit });
                        const serverMessages = (serverResult?.messages ?? []) as Array<{ timestamp?: number; id?: string }>;
                        const newServerMessages = afterTs > 0
                            ? serverMessages.filter(m => (m.timestamp ?? 0) > afterTs)
                            : serverMessages;

                        if (newServerMessages.length > 0) {
                            // Append new messages to local file so cursor advances normally next time
                            for (const msg of newServerMessages) {
                                await fs.promises.appendFile(localPath, JSON.stringify(msg) + '\n', 'utf-8');
                            }
                            return {
                                content: [{
                                    type: 'text',
                                    text: JSON.stringify({
                                        fromCursor: cursor,
                                        nextCursor: cursor + newServerMessages.length,
                                        totalLines: lines.length + newServerMessages.length,
                                        hasNewContent: true,
                                        rotationFallback: true,
                                        messages: newServerMessages,
                                    }, null, 2)
                                }],
                                isError: false
                            };
                        }
                    } catch (fallbackErr) {
                        // Non-fatal: return the original hasNew=false result below
                    }
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            fromCursor: cursor,
                            nextCursor: newCursor,
                            totalLines: lines.length,
                            hasNewContent: hasNew,
                            messages: newLines.map(l => { try { return JSON.parse(l); } catch { return l; } }),
                        }, null, 2)
                    }],
                    isError: false
                };
            }
            const messages = await api.getTeamMessages(args.teamId, { limit: args.limit });
            return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }], isError: false };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error reading team log: ${String(error)}` }], isError: true };
        }
    });

    // ─── get_context_status ───────────────────────────────────────────────────
    // Agent calls this to know its own context window usage — same data source as ccusage.
    // Reads the CC log JSONL, extracts the LAST message's usage:
    //   current_context_K = (input_tokens + cache_creation_input_tokens + cache_read_input_tokens) / 1000
    mcp.registerTool('get_context_status', {
        description: [
            'Check your own current context window usage and remaining capacity.',
            'Returns real token counts from your CC log (same data ccusage reads).',
            'Call this when starting a large task, or when you suspect you may be approaching the limit.',
            'If context > 150K, consider outputting /compact to preserve performance.',
        ].join(' '),
        title: 'Get Context Status',
        inputSchema: {
            sessionId: z.string().optional().describe('Session ID to check. Omit to check yourself (uses list_team_cc_logs to find your log).'),
        },
    }, async (args) => {
        try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const homeDir = process.env.HOME || '/tmp';
            const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

            // Resolve which session to check
            let targetSessionId = args.sessionId;
            let logFilePath: string | null = null;

            if (!targetSessionId) {
                // Find our own log: query daemon for current team's CC logs, match our ahaSessionId
                try {
                    const daemonState = await readDaemonState();
                    if (daemonState?.httpPort) {
                        const teamId = client.getMetadata()?.teamId;
                        if (teamId) {
                            const res = await fetch(`http://127.0.0.1:${daemonState.httpPort}/list-team-logs?teamId=${teamId}`, {
                                signal: AbortSignal.timeout(3_000)
                            });
                            if (res.ok) {
                                const data = await res.json() as Array<{ ahaSessionId: string; logFilePath?: string }>;
                                const myEntry = data.find(e => e.ahaSessionId === client.sessionId);
                                if (myEntry?.logFilePath) logFilePath = myEntry.logFilePath;
                            }
                        }
                    }
                } catch { /* fall through to scan */ }

                // Fallback: most recently modified JSONL in last 5 minutes that belongs to cwd
                if (!logFilePath && fs.existsSync(claudeProjectsDir)) {
                    const now = Date.now();
                    let newest = 0;
                    for (const dir of fs.readdirSync(claudeProjectsDir)) {
                        const dirPath = path.join(claudeProjectsDir, dir);
                        try {
                            for (const file of fs.readdirSync(dirPath)) {
                                if (!file.endsWith('.jsonl')) continue;
                                const fp = path.join(dirPath, file);
                                const mtime = fs.statSync(fp).mtimeMs;
                                if (mtime > newest && (now - mtime) < 5 * 60 * 1000) {
                                    newest = mtime;
                                    logFilePath = fp;
                                }
                            }
                        } catch { /* skip */ }
                    }
                }
            } else {
                // Find by sessionId
                for (const dir of fs.readdirSync(claudeProjectsDir)) {
                    const candidate = path.join(claudeProjectsDir, dir, `${targetSessionId}.jsonl`);
                    if (fs.existsSync(candidate)) { logFilePath = candidate; break; }
                }
            }

            if (!logFilePath || !fs.existsSync(logFilePath)) {
                return { content: [{ type: 'text', text: 'CC log not found. Cannot determine context status.' }], isError: false };
            }

            // Read log and extract usage (same algorithm as ccusage)
            const lines = fs.readFileSync(logFilePath, 'utf-8').split('\n').filter(Boolean);
            let lastUsage: Record<string, number> | null = null;
            let totalInputK = 0;
            let totalOutputK = 0;
            let turns = 0;

            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'assistant') {
                        const usage = entry.message?.usage;
                        if (usage) {
                            lastUsage = usage;
                            totalInputK += ((usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0)) / 1000;
                            totalOutputK += (usage.output_tokens || 0) / 1000;
                            turns++;
                        }
                    }
                } catch { /* skip */ }
            }

            if (!lastUsage) {
                return { content: [{ type: 'text', text: 'No usage data found in CC log yet.' }], isError: false };
            }

            // Current context = last message's total input (= what was fed into this turn)
            const currentContextK = Math.round(
                ((lastUsage.input_tokens || 0) +
                 (lastUsage.cache_creation_input_tokens || 0) +
                 (lastUsage.cache_read_input_tokens || 0)) / 1000
            );
            const contextLimitK = 200; // claude-opus-4 / claude-sonnet-4
            const remainingK = contextLimitK - currentContextK;
            const pct = Math.round((currentContextK / contextLimitK) * 100);

            const status = pct >= 85 ? '🔴 CRITICAL — compact now' :
                           pct >= 70 ? '🟡 HIGH — consider /compact soon' :
                           pct >= 50 ? '🟢 MODERATE — plenty remaining' :
                                       '🟢 LOW — context is fresh';

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        currentContextK,
                        remainingK,
                        usedPercent: pct,
                        status,
                        turns,
                        cumulativeCost: {
                            inputK: Math.round(totalInputK),
                            outputK: Math.round(totalOutputK),
                        },
                        recommendation: pct >= 85
                            ? 'Output /compact immediately to avoid context overflow'
                            : pct >= 70
                            ? 'Plan to /compact after finishing current subtask'
                            : 'Context healthy — no action needed',
                    }, null, 2)
                }],
                isError: false
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('read_cc_log', {
        description: 'Read Claude Code session log (the iron proof). Shows actual tool calls since last supervisor run (cursor-based). Supervisor/help-agent only.',
        title: 'Read CC Log',
        inputSchema: {
            sessionId: z.string().describe('Session ID to read CC log for'),
            limit: z.number().default(100).describe('Max log entries to return'),
            fromByteOffset: z.number().default(-1).describe('Byte offset to read from. -1 = use env AHA_SUPERVISOR_CC_LOG_CURSORS for this sessionId. 0 = read all.'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can read CC logs.' }], isError: true };
        }
        try {
            const result = readRuntimeLog({
                homeDir: process.env.HOME || '/tmp',
                runtimeType: 'claude',
                sessionId: args.sessionId,
                logKind: 'session',
                fromCursor: args.fromByteOffset,
                limit: args.limit,
                ccLogCursorsEnv: process.env.AHA_SUPERVISOR_CC_LOG_CURSORS,
            });

            const summary = result.entries.map((entry) => {
                try {
                    const parsed = entry as any;
                    if (parsed.type === 'assistant' && parsed.message?.content) {
                        const parts = Array.isArray(parsed.message.content) ? parsed.message.content : [];
                        const out: string[] = [];
                        for (const c of parts) {
                            if (c.type === 'text' && c.text?.trim()) {
                                out.push(`[text] ${c.text.trim().slice(0, 300)}`);
                            } else if (c.type === 'tool_use') {
                                let inputSnippet = '';
                                if (c.input) {
                                    if (typeof c.input.command === 'string') {
                                        inputSnippet = c.input.command.slice(0, 200);
                                    } else if (typeof c.input.file_path === 'string') {
                                        inputSnippet = c.input.file_path;
                                    } else if (typeof c.input.path === 'string') {
                                        inputSnippet = c.input.path;
                                    } else if (typeof c.input.query === 'string') {
                                        inputSnippet = c.input.query.slice(0, 200);
                                    } else {
                                        inputSnippet = JSON.stringify(c.input).slice(0, 200);
                                    }
                                }
                                out.push(`[tool_use] ${c.name}${inputSnippet ? `: ${inputSnippet}` : ''}`);
                            }
                        }
                        return out.length > 0 ? out.join('\n') : null;
                    }
                    if (parsed.type === 'user' && parsed.message?.content) {
                        const parts = Array.isArray(parsed.message.content) ? parsed.message.content : [];
                        const out: string[] = [];
                        for (const c of parts) {
                            if (c.type === 'tool_result') {
                                const resultText = Array.isArray(c.content)
                                    ? c.content.filter((r: any) => r.type === 'text').map((r: any) => r.text).join('').slice(0, 400)
                                    : typeof c.content === 'string' ? c.content.slice(0, 400) : '';
                                out.push(`[tool_result]${c.is_error ? ' ERROR' : ''} ${resultText || '(empty)'}`);
                            }
                        }
                        return out.length > 0 ? out.join('\n') : null;
                    }
                    return null;
                } catch {
                    return null;
                }
            }).filter(Boolean);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        sessionId: args.sessionId,
                        fromByteOffset: result.fromCursor,
                        nextByteOffset: result.nextCursor,
                        fileSize: result.totalCount,
                        hasNewContent: result.hasNewContent,
                        entries: summary,
                    }, null, 2)
                }],
                isError: false
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error reading CC log: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('score_agent', {
        description: [
            'Write an evaluation score for an agent to the local score table. Hard-first protocol:',
            '1. Always provide hardMetrics (raw event counts from read_cc_log + list_tasks).',
            '2. Optionally provide businessMetrics (derived rates from CC-log cross-validation) for richer dimension accuracy.',
            '3. Supervisor session scoring should explicitly judge 3 business axes: task_completion + code_quality + collaboration.',
            '4. sessionScore.overall must stay within ±20 of hardMetricsScore unless you intentionally override the guardrail.',
            'v1 legacy (no hardMetrics): manual delivery/integrity/efficiency/collaboration/reliability still accepted.',
            'Supervisor only.',
        ].join(' '),
        title: 'Score Agent',
        inputSchema: {
            sessionId: z.string(),
            teamId: z.string(),
            role: z.string(),
            specId: z.string().optional().describe('Genome ID of the agent being scored. Get from list_team_agents.'),
            // ── v2 layer 1: raw event counts (required for hard-first) ───────────
            hardMetrics: z.object({
                tasksAssigned: z.number().int().min(0).describe('Tasks formally assigned to this agent (from list_tasks)'),
                tasksCompleted: z.number().int().min(0).describe('Tasks marked done/completed (from list_tasks)'),
                tasksBlocked: z.number().int().min(0).default(0).describe('Tasks that entered a blocked state'),
                toolCallCount: z.number().int().min(0).default(0).describe('Total tool/MCP calls made (from read_cc_log)'),
                toolErrorCount: z.number().int().min(0).default(0).describe('Tool calls that returned isError=true (from read_cc_log)'),
                messagesSent: z.number().int().min(0).default(0).describe('Total messages sent to the team (from read_team_log)'),
                protocolMessages: z.number().int().min(0).default(0).describe('task-update or notification messages (protocol-correct, from read_team_log)'),
                sessionDurationMinutes: z.number().min(0).default(0).describe('Session wall-clock duration in minutes'),
                tokensUsed: z.number().int().min(0).default(0).describe('Total tokens consumed input+output (from read_cc_log)'),
            }).optional().describe('Raw event counts (layer 1). Required for hard-first scoring.'),
            // ── v2 layer 2: business-level metrics (optional, improves accuracy) ─
            businessMetrics: z.object({
                taskCompletionRate: z.number().min(0).max(1).describe('tasksCompleted / tasksAssigned (0.0–1.0)'),
                firstPassReviewRate: z.number().min(0).max(1).describe('Fraction of submissions passing review without rework (0.0–1.0)'),
                verifiedToolCallCount: z.number().int().min(0).describe('Tool calls confirmed in CC log evidence (≥0)'),
                boardComplianceRate: z.number().min(0).max(1).describe('Fraction of board updates following protocol (0.0–1.0)'),
                claimEvidenceDelta: z.number().min(0).max(1).describe('Claim-evidence gap: 0=perfect CC-log match, 1=all claims unverified'),
                bugRate: z.number().min(0).describe('Confirmed regressions per completed task (0.0+; 0=none introduced)'),
            }).optional().describe('Business-level hard metrics (layer 2). Derived from CC-log cross-validation. Improves dimension accuracy when provided.'),
            sessionScore: z.object({
                taskCompletion: z.number().min(0).max(100).describe('Supervisor business score for task completion / closure'),
                codeQuality: z.number().min(0).max(100).describe('Supervisor business score for code quality / rework risk'),
                collaboration: z.number().min(0).max(100).describe('Supervisor business score for collaboration / protocol fit'),
            }).optional().describe('Canonical 3-axis session score written to the genome feedback loop. If omitted, derived automatically from dimensions.'),
            // ── v1: manual dimensions (legacy fallback) ────────────────────────
            delivery: z.number().min(0).max(100).optional().describe('Legacy: manual delivery score. Ignored when hardMetrics is provided.'),
            integrity: z.number().min(0).max(100).optional().describe('Legacy: manual integrity score. Ignored when hardMetrics is provided.'),
            efficiency: z.number().min(0).max(100).optional().describe('Legacy: manual efficiency score. Ignored when hardMetrics is provided.'),
            collaboration: z.number().min(0).max(100).optional().describe('Legacy: manual collaboration score. Ignored when hardMetrics is provided.'),
            reliability: z.number().min(0).max(100).optional().describe('Legacy: manual reliability score. Ignored when hardMetrics is provided.'),
            overall: z.number().min(0).max(100).optional().describe('Optional explicit overall override. Defaults to sessionScore.overall (or hardMetricsScore if no sessionScore). Must satisfy the score-gap guardrail.'),
            maxScoreGap: z.number().min(0).max(100).default(20).optional().describe('Maximum allowed |hardMetricsScore - overall| before returning an error. Default 20.'),
            evidence: z.record(z.any()).optional(),
            recommendations: z.array(z.string()).optional(),
            action: z.enum(['keep', 'keep_with_guardrails', 'mutate', 'discard']),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor can score agents.' }], isError: true };
        }

        // Try to resolve specId namespace/name from genome-hub for cleaner grouping
        let specNamespace: string | undefined;
        let specName: string | undefined;
        if (args.specId) {
            try {
                const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
                const res = await fetch(`${hubUrl}/genomes/id/${encodeURIComponent(args.specId)}`, { signal: AbortSignal.timeout(3_000) });
                if (res.ok) {
                    const data = await res.json() as { genome?: { namespace?: string; name?: string } };
                    specNamespace = data.genome?.namespace ?? undefined;
                    specName = data.genome?.name ?? undefined;
                }
            } catch { /* proceed without */ }
        }

        // Resolve dimension scores: hard-first (business > raw counts > manual legacy)
        const { computeDimensionsFromMetrics, computeHardMetricsScore, validateScoreGap } = await import('@/claude/utils/feedbackPrivacy');
        const { computeSessionScoreFromDimensions, computeSessionScoreOverall } = await import('@/claude/utils/sessionScoring');

        let dimensions: { delivery: number; integrity: number; efficiency: number; collaboration: number; reliability: number };
        let hardMetricsScore: number | undefined;
        let scoringMode: 'business_metrics' | 'hard_metrics' | 'manual';

        if (args.hardMetrics) {
            dimensions = computeDimensionsFromMetrics(args.hardMetrics, args.businessMetrics);
            hardMetricsScore = computeHardMetricsScore(args.hardMetrics, args.businessMetrics);
            scoringMode = args.businessMetrics ? 'business_metrics' : 'hard_metrics';
        } else {
            // Legacy: require all 5 dimensions to be present
            const d = args.delivery ?? 50;
            const i = args.integrity ?? 50;
            const e = args.efficiency ?? 50;
            const c = args.collaboration ?? 50;
            const r = args.reliability ?? 50;
            dimensions = { delivery: d, integrity: i, efficiency: e, collaboration: c, reliability: r };
            scoringMode = 'manual';
        }

        const sessionScore = args.sessionScore
            ? computeSessionScoreOverall(args.sessionScore)
            : computeSessionScoreFromDimensions(dimensions);

        // Compute overall: use provided override or default to the 3-axis session score
        const baseOverall = sessionScore.overall ?? hardMetricsScore ?? Math.round(
            (dimensions.delivery + dimensions.integrity + dimensions.efficiency + dimensions.collaboration + dimensions.reliability) / 5,
        );
        const overall = args.overall !== undefined ? args.overall : baseOverall;

        // Gap guard: overall must be within ±maxScoreGap of hardMetricsScore
        const maxScoreGap = args.maxScoreGap ?? 20;
        if (hardMetricsScore !== undefined) {
            const gapWarning = validateScoreGap(hardMetricsScore, overall, maxScoreGap);
            if (gapWarning) {
                return { content: [{ type: 'text', text: `Error: ${gapWarning}` }], isError: true };
            }
        }

        const scoreGap = hardMetricsScore !== undefined
            ? {
                ok: Math.abs(hardMetricsScore - overall) <= maxScoreGap,
                gap: Math.abs(hardMetricsScore - overall),
                maxGap: maxScoreGap,
            }
            : { ok: true, gap: 0, maxGap: maxScoreGap };

        writeScore({
            sessionId: args.sessionId,
            teamId: args.teamId,
            role: args.role,
            specId: args.specId,
            specNamespace,
            specName,
            timestamp: Date.now(),
            scorer: client.sessionId,
            hardMetrics: args.hardMetrics,
            businessMetrics: args.businessMetrics,
            hardMetricsScore,
            sessionScore,
            scoreGap,
            dimensions,
            overall,
            evidence: args.evidence || {},
            recommendations: args.recommendations || [],
            action: args.action,
        });

        const dimSummary = `delivery=${dimensions.delivery} integrity=${dimensions.integrity} efficiency=${dimensions.efficiency} collaboration=${dimensions.collaboration} reliability=${dimensions.reliability}`;
        const hardInfo = hardMetricsScore !== undefined ? ` hardMetricsScore=${hardMetricsScore}` : '';
        const sessionInfo = ` sessionScore(task_completion=${sessionScore.taskCompletion}, code_quality=${sessionScore.codeQuality}, collaboration=${sessionScore.collaboration}, overall=${sessionScore.overall})`;
        return {
            content: [{
                type: 'text',
                text: `Scored ${args.role}${args.specId ? ` (specId=${args.specId})` : ''} session=${args.sessionId}: overall=${overall},${hardInfo}${sessionInfo} action=${args.action}, mode=${scoringMode}\n${dimSummary}`,
            }],
            isError: false,
        };
    });

    mcp.registerTool('update_genome_feedback', {
        description: [
            'Push aggregate performance feedback for a genome role to the public marketplace.',
            'Reads local scores for the specified role, computes aggregate statistics,',
            'strips all private data (session IDs, team IDs, file paths, evidence),',
            'and uploads only anonymized behavioral patterns and aggregate scores.',
            'Supervisor only. Run after scoring at least 3 sessions of the same role.',
        ].join(' '),
        title: 'Update Genome Feedback',
        inputSchema: {
            genomeNamespace: z.string().describe("Genome namespace, e.g. '@official'"),
            genomeName: z.string().describe("Genome name, e.g. 'implementer'"),
            genomeId: z.string().optional().describe('Genome ID (preferred over namespace+name). When provided, scores are filtered by specId first, falling back to role name match.'),
            role: z.string().describe('Role name used as fallback filter when specId not recorded on older scores'),
            dryRun: z.boolean().optional().describe('If true, show what would be sent without uploading'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (callerRole !== 'supervisor') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor can update genome feedback.' }], isError: true };
        }

        // Read local scores — prefer specId match, fall back to role name
        const { readScores } = await import('@/claude/utils/scoreStorage');
        const { scores } = readScores();
        const roleScores = args.genomeId
            ? scores.filter(s => s.specId === args.genomeId || (s.specName === args.genomeName && s.specNamespace === args.genomeNamespace) || s.role === args.role)
            : scores.filter(s => s.role === args.role);

        if (roleScores.length === 0) {
            return { content: [{ type: 'text', text: `No scores found for role '${args.role}'. Score agents first with score_agent tool.` }], isError: false };
        }

        if (roleScores.length < 3) {
            return { content: [{ type: 'text', text: `Only ${roleScores.length} score(s) for role '${args.role}'. Recommend at least 3 evaluations before publishing feedback.` }], isError: false };
        }

        // Aggregate and sanitize (no PII leaves the device)
        const feedback = aggregateScores(roleScores);
        if (!feedback) {
            return { content: [{ type: 'text', text: 'Failed to aggregate scores.' }], isError: true };
        }

        const summary = [
            `Aggregated ${feedback.evaluationCount} evaluations for ${args.role}`,
            `Overall avg: ${feedback.avgScore}/100`,
            `Session score: task_completion=${feedback.sessionScore.taskCompletion} code_quality=${feedback.sessionScore.codeQuality} collaboration=${feedback.sessionScore.collaboration} overall=${feedback.sessionScore.overall}`,
            `Dimensions: delivery=${feedback.dimensions.delivery} integrity=${feedback.dimensions.integrity} efficiency=${feedback.dimensions.efficiency} collaboration=${feedback.dimensions.collaboration} reliability=${feedback.dimensions.reliability}`,
            `Distribution: excellent=${feedback.distribution.excellent} good=${feedback.distribution.good} fair=${feedback.distribution.fair} poor=${feedback.distribution.poor}`,
            `Latest action: ${feedback.latestAction}`,
            `Suggestions (${feedback.suggestions.length}): ${feedback.suggestions.slice(0, 3).join(' | ')}`,
        ].join('\n');

        if (args.dryRun) {
            return { content: [{ type: 'text', text: `DRY RUN — would send:\n${summary}\n\nPrivacy: session IDs, team IDs, file paths, and raw evidence are stripped before upload.` }], isError: false };
        }

        // Send to genome-hub
        const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
        const hubKey = process.env.HUB_PUBLISH_KEY ?? '';
        const encodedNs = encodeURIComponent(args.genomeNamespace);

        try {
            const res = await fetch(`${hubUrl}/genomes/${encodedNs}/${args.genomeName}/feedback`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    ...(hubKey ? { 'Authorization': `Bearer ${hubKey}` } : {}),
                },
                body: JSON.stringify(feedback),
                signal: AbortSignal.timeout(15_000),
            });

            if (!res.ok) {
                const err = await res.text();
                return { content: [{ type: 'text', text: `Failed to update genome hub: ${res.status} ${err}` }], isError: true };
            }

            return { content: [{ type: 'text', text: `Feedback uploaded to marketplace:\n${summary}` }], isError: false };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('compact_agent', {
        description: 'Trigger context compaction on a running agent. Sends /compact command to reduce context window usage while preserving key information. Supervisor/help-agent only.',
        title: 'Compact Agent',
        inputSchema: {
            sessionId: z.string().describe('Session ID of agent to compact'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can compact agents.' }], isError: true };
        }
        try {
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) {
                return { content: [{ type: 'text', text: 'Daemon not running.' }], isError: true };
            }
            const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/session-command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: args.sessionId, command: '/compact' }),
                signal: AbortSignal.timeout(10_000),
            });
            const result = await response.json() as any;
            return { content: [{ type: 'text', text: result.success ? `Compacted ${args.sessionId}` : `Failed: ${result.error}` }], isError: !result.success };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('kill_agent', {
        description: 'Terminate a running agent. Use as last resort when an agent is unresponsive or causing problems. Supervisor/help-agent only.',
        title: 'Kill Agent',
        inputSchema: {
            sessionId: z.string().describe('Session ID of agent to kill'),
            reason: z.string().describe('Why this agent needs to be killed'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can kill agents.' }], isError: true };
        }
        try {
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) {
                return { content: [{ type: 'text', text: 'Daemon not running.' }], isError: true };
            }
            const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/stop-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: args.sessionId }),
                signal: AbortSignal.timeout(10_000),
            });
            await response.json();
            return { content: [{ type: 'text', text: `Killed ${args.sessionId}: ${args.reason}` }], isError: false };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    // ========== Runtime-Aware Supervisor Log Tools ==========

    mcp.registerTool('list_team_runtime_logs', {
        description: 'List runtime log files for team agents across Claude and Codex. Returns ahaSessionId → runtimeType + log paths. Supervisor/help-agent only.',
        title: 'List Team Runtime Logs',
        inputSchema: {
            teamId: z.string().describe('Team ID to list runtime logs for'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can use this tool.' }], isError: true };
        }
        try {
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) {
                return { content: [{ type: 'text', text: 'Daemon not running or port unknown.' }], isError: true };
            }

            const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/list-team-sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: args.teamId }),
                signal: AbortSignal.timeout(5_000),
            });

            const result = await response.json() as {
                sessions: Array<{
                    ahaSessionId: string;
                    claudeLocalSessionId?: string;
                    runtimeType?: string;
                    role?: string;
                    pid: number;
                }>;
            };

            const homeDir = process.env.HOME || '/tmp';
            const enriched = resolveTeamRuntimeLogs(result.sessions, homeDir);

            return {
                content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('read_runtime_log', {
        description: 'Read runtime-aware supervisor evidence logs with cursor support. Supports Claude session logs, Codex history, and Codex session transcripts. Supervisor/help-agent only.',
        title: 'Read Runtime Log',
        inputSchema: {
            runtimeType: z.enum(['claude', 'codex', 'open-code']).describe('Runtime to read logs for'),
            sessionId: z.string().optional().describe('Claude local session id or Codex transcript session id. Required for session logs.'),
            logKind: z.enum(['session', 'history']).default('session').describe('Log kind. Use "history" for ~/.codex/history.jsonl.'),
            limit: z.number().default(100).describe('Max log entries to return'),
            fromCursor: z.number().default(-1).describe('Cursor to read from. Byte offset for session logs, line cursor for codex history. -1 = use supervisor env cursor.'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can read runtime logs.' }], isError: true };
        }
        try {
            const result = readRuntimeLog({
                homeDir: process.env.HOME || '/tmp',
                runtimeType: args.runtimeType,
                sessionId: args.sessionId,
                logKind: args.logKind,
                fromCursor: args.fromCursor,
                limit: args.limit,
                ccLogCursorsEnv: process.env.AHA_SUPERVISOR_CC_LOG_CURSORS,
                codexHistoryCursorEnv: process.env.AHA_SUPERVISOR_CODEX_HISTORY_CURSOR,
                codexSessionCursorsEnv: process.env.AHA_SUPERVISOR_CODEX_SESSION_CURSORS,
            });

            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error reading runtime log: ${String(error)}` }], isError: true };
        }
    });

    // ========== List Team CC Logs (supervisor only) ==========

    mcp.registerTool('list_team_cc_logs', {
        description: 'List Claude Code log files for all agents in a team by querying the daemon. Returns ahaSessionId → claudeLocalSessionId + log file path. Call this first before read_cc_log to get correct session IDs. Supervisor/help-agent only.',
        title: 'List Team CC Logs',
        inputSchema: {
            teamId: z.string().describe('Team ID to list CC logs for'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can use this tool.' }], isError: true };
        }
        try {
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) {
                return { content: [{ type: 'text', text: 'Daemon not running or port unknown.' }], isError: true };
            }
            const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/list-team-sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: args.teamId }),
                signal: AbortSignal.timeout(5_000),
            });
            const result = await response.json() as { sessions: Array<{ ahaSessionId: string; claudeLocalSessionId?: string; role?: string; pid: number }> };

            const fs = await import('node:fs');
            const path = await import('node:path');
            const homeDir = process.env.HOME || '/tmp';
            const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

            const enriched = result.sessions.map(session => {
                let logFilePath: string | null = null;
                let logFileSize: number | null = null;
                if (session.claudeLocalSessionId && fs.existsSync(claudeProjectsDir)) {
                    for (const dir of fs.readdirSync(claudeProjectsDir)) {
                        const candidate = path.join(claudeProjectsDir, dir, `${session.claudeLocalSessionId}.jsonl`);
                        if (fs.existsSync(candidate)) {
                            logFilePath = candidate;
                            logFileSize = fs.statSync(candidate).size;
                            break;
                        }
                    }
                }
                return { ...session, logFilePath, logFileSize };
            });

            return {
                content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    // ========== Save Supervisor State Tool (supervisor only) ==========
    mcp.registerTool('save_supervisor_state', {
        description: 'Persist supervisor state (team / Claude / Codex log cursors + conclusion + pending action + predictions) so the next supervisor run reads only new content and can verify predictions. Call this after scoring agents, before SUPERVISOR_COMPLETE. Supervisor only.',
        title: 'Save Supervisor State',
        inputSchema: {
            teamId: z.string().describe('Team ID being supervised'),
            teamLogCursor: z.number().describe('nextCursor value returned by read_team_log'),
            ccLogCursors: z.record(z.string(), z.number()).describe('Map of sessionId → nextByteOffset from read_cc_log results'),
            codexHistoryCursor: z.number().optional().describe('Line cursor into ~/.codex/history.jsonl after the last inspected entry'),
            codexSessionCursors: z.record(z.string(), z.number()).optional().describe('Map of Codex session id → next byte offset in ~/.codex/sessions/... transcript files'),
            conclusion: z.string().describe('2-4 sentence plain-text summary of this supervisor cycle findings'),
            sessionId: z.string().optional().describe('This supervisor session ID (for potential --resume on next run)'),
            teamTerminated: z.boolean().default(false).describe('Set true if the team appears fully done and no further supervision is needed'),
            pendingAction: z.union([
                z.object({
                    type: z.literal('notify_help'),
                    message: z.string().describe('Help/intervention message to carry into the next cycle'),
                }),
                z.object({
                    type: z.literal('conditional_escalation'),
                    condition: z.string().describe('Human-readable condition to re-check next cycle'),
                    action: z.string().describe('Action to take if the condition still holds'),
                    deadline: z.number().describe('Unix ms deadline after which the escalation should trigger'),
                }),
                z.null(),
            ]).optional().describe('Deferred action to execute next cycle if the situation still has not changed'),
            predictions: z.array(z.object({
                agentSessionId: z.string().describe('Session ID of the agent this prediction is about'),
                type: z.enum(['score_direction', 'will_block', 'will_complete', 'needs_intervention']).describe('Prediction category'),
                description: z.string().describe('Human-readable prediction'),
                predictedValue: z.number().optional().describe('Predicted numeric value (for score_direction)'),
                confidence: z.number().min(0).max(100).describe('Confidence level 0-100'),
            })).optional().describe('Predictions about agent states for next-run Phase 0 verification (v2 self-reflexivity)'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor can save supervisor state.' }], isError: true };
        }
        try {
            const { readSupervisorState, updateSupervisorState } = await import('@/daemon/supervisorState');
            const existing = readSupervisorState(args.teamId);

            // Build predictions with timestamp
            const predictions = args.predictions?.map(p => ({
                ...p,
                predictedAt: Date.now(),
            }));

            await updateSupervisorState(args.teamId, (state) => ({
                ...state,
                lastRunAt: Date.now(),
                teamLogCursor: args.teamLogCursor,
                ccLogCursors: args.ccLogCursors,
                codexHistoryCursor: args.codexHistoryCursor ?? state.codexHistoryCursor,
                codexSessionCursors: args.codexSessionCursors ?? state.codexSessionCursors,
                lastConclusion: args.conclusion,
                lastSessionId: args.sessionId ?? state.lastSessionId,
                terminated: args.teamTerminated,
                idleRuns: 0,
                pendingAction: args.pendingAction !== undefined ? args.pendingAction : state.pendingAction,
                predictions,
            }));
            const predCount = predictions?.length ?? 0;
            return {
                content: [{
                    type: 'text',
                    text: `Supervisor state saved. Next run starts at team=${args.teamLogCursor}, codexHistory=${args.codexHistoryCursor ?? existing.codexHistoryCursor}. Terminated=${args.teamTerminated}. Predictions=${predCount}`
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error saving supervisor state: ${String(error)}` }], isError: true };
        }
    });

    // ========== Score Supervisor Self (v2 self-reflexivity) ==========

    mcp.registerTool('score_supervisor_self', {
        description: `Record prediction outcomes and update supervisor calibration. Call this in Phase 0 after verifying predictions from the previous run. Supervisor only.

The calibration score tracks how accurate the supervisor's predictions are over time:
- calibrationScore = correctPredictions / totalPredictions * 100
- rollingAccuracy = exponential moving average over last 5 cycles
- scoreBiasTrend = average (predictedValue - actualValue), positive = overestimates

If calibrationScore drops below 60 over 5+ runs, reduce confidence on new predictions by 15 points.`,
        title: 'Score Supervisor Self',
        inputSchema: {
            teamId: z.string().describe('Team ID being supervised'),
            predictionOutcomes: z.array(z.object({
                agentSessionId: z.string().describe('Agent session ID the prediction was about'),
                predictionType: z.string().describe('Original prediction type (score_direction, will_block, etc.)'),
                predicted: z.string().describe('What was predicted (brief)'),
                actual: z.string().describe('What actually happened (brief)'),
                correct: z.boolean().describe('Whether the prediction was correct'),
                predictedValue: z.number().optional().describe('Original predicted numeric value'),
                actualValue: z.number().optional().describe('Actual observed numeric value'),
            })).describe('Outcomes for each prediction from the previous run'),
            selfAssessment: z.string().optional().describe('Brief self-assessment of prediction quality this cycle'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor can score itself.' }], isError: true };
        }
        try {
            const { readSupervisorState, updateSupervisorState, updateCalibration } = await import('@/daemon/supervisorState');
            const state = readSupervisorState(args.teamId);

            // Build PredictionOutcome objects
            const outcomes = args.predictionOutcomes.map(o => {
                const matchingPrediction = state.predictions?.find(
                    p => p.agentSessionId === o.agentSessionId && p.type === o.predictionType
                );
                return {
                    prediction: matchingPrediction ?? {
                        agentSessionId: o.agentSessionId,
                        type: o.predictionType as 'score_direction' | 'will_block' | 'will_complete' | 'needs_intervention',
                        description: o.predicted,
                        predictedValue: o.predictedValue,
                        predictedAt: state.lastRunAt,
                        confidence: 50,
                    },
                    actualOutcome: o.actual,
                    actualValue: o.actualValue,
                    correct: o.correct,
                    calibrationError: Math.abs(
                        ((matchingPrediction?.confidence ?? 50) / 100) - (o.correct ? 1 : 0)
                    ),
                };
            });

            const calibration = updateCalibration(state.calibration, outcomes);

            // Write updated calibration (predictions are cleared — they've been verified)
            await updateSupervisorState(args.teamId, (current) => ({
                ...current,
                calibration,
                predictions: undefined,
            }));

            const lines = [
                `Calibration updated: ${calibration.calibrationScore}% accuracy (${calibration.correctPredictions}/${calibration.totalPredictions} correct)`,
                `Rolling accuracy (last 5): ${calibration.rollingAccuracy}%`,
                `Score bias trend: ${calibration.scoreBiasTrend > 0 ? '+' : ''}${calibration.scoreBiasTrend}`,
            ];

            if (calibration.calibrationScore < 60 && calibration.totalPredictions >= 5) {
                lines.push('⚠️ Low calibration accuracy — reduce confidence on new predictions by 15 points.');
            }

            if (args.selfAssessment) {
                lines.push(`Self-assessment: ${args.selfAssessment}`);
            }

            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error scoring supervisor self: ${String(error)}` }], isError: true };
        }
    });

    // ========== Request Help Tool (ALL agents) ==========

    mcp.registerTool('request_help', {
        description: `Request help from the supervisor system. Call this when you are stuck, encountering errors, running low on context, or need a collaborator.

The help request will be logged and may trigger a help-agent to assist you. Common scenarios:
- You've been stuck on a task for multiple attempts
- You're getting repeated errors you can't resolve
- Your context window is getting full (you notice degraded performance)
- You need a role/skill that doesn't exist on the team yet

The supervisor will see your request and may: send you guidance, compact your context, restart your session, or spawn a helper agent.`,
        title: 'Request Help',
        inputSchema: {
            type: z.enum(['stuck', 'context_overflow', 'need_collaborator', 'error', 'custom']).describe('Type of help needed'),
            description: z.string().describe('Detailed description of the problem and what you have tried'),
            severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium').describe('Urgency level'),
            taskId: z.string().optional().describe('Related task ID if applicable'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const sessionId = client.sessionId;

            if (!teamId) {
                return {
                    content: [{ type: 'text', text: 'Error: You are not part of a team.' }],
                    isError: true,
                };
            }

            // Write help request event to JSONL file
            const fs = await import('node:fs');
            const path = await import('node:path');
            const eventsDir = path.join(process.cwd(), '.aha', 'events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const event = {
                timestamp: new Date().toISOString(),
                sessionId,
                teamId,
                role,
                type: args.type,
                description: args.description,
                severity: args.severity,
                taskId: args.taskId,
            };

            const eventsFile = path.join(eventsDir, 'help_requests.jsonl');
            fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');

            // Send a team message so supervisor can see it
            try {
                const severityEmoji = args.severity === 'critical' ? '🚨' : args.severity === 'high' ? '🆘' : '🙋';
                const shortDesc = args.description.length > 150 ? args.description.substring(0, 150) + '...' : args.description;
                await api.sendTeamMessage(teamId, {
                    id: randomUUID(),
                    teamId,
                    content: `${severityEmoji} Help requested (${args.type}, ${args.severity}): ${args.description}`,
                    shortContent: `${severityEmoji} Help: ${shortDesc}`,
                    type: 'notification',
                    timestamp: Date.now(),
                    fromSessionId: sessionId,
                    fromRole: role,
                    metadata: { helpType: args.type, severity: args.severity, taskId: args.taskId },
                });
            } catch (e) {
                logger.debug('Failed to send help request notification', e);
            }

            // Write pendingAction so the daemon supervisor loop picks it up
            try {
                const { updateSupervisorRun } = await import('@/daemon/supervisorState');
                await updateSupervisorRun(teamId, {
                    pendingAction: {
                        type: 'notify_help',
                        message: `[${args.severity}] ${args.description}`,
                    },
                });
                logger.debug(`[request_help] pendingAction saved for team ${teamId}`);
            } catch (e) {
                logger.debug('[request_help] Failed to save pendingAction (non-fatal)', e);
            }

            return {
                content: [{
                    type: 'text',
                    text: `Help request logged (${args.type}, severity: ${args.severity}). The supervisor has been notified and may respond with guidance, restart your session, or spawn a helper agent.`,
                }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error requesting help: ${String(error)}` }],
                isError: true,
            };
        }
    });

    // ========== Create Genome Tool (Evolution System, M3) ==========
    mcp.registerTool('create_genome', {
        description: `Save or update a reusable agent specification (genome) in the team evolution store.
A genome captures everything needed to reproduce a high-performing agent: system prompt,
tool access list, model, permission mode, and any domain knowledge to seed the agent's context.

Genomes can be instantiated later via the \`specId\` parameter of \`create_agent\`.

Use this tool when:
- You have refined an agent's behavior and want to preserve it for future spawns
- You want to share an agent specification with team members
- You are evolving an existing genome after observing performance

On genome-hub, repeated saves of the same namespace/name go through version promotion:
- first save creates v1
- later saves create vN+1 only if the latest version has enough supervisor score
- otherwise the call fails with validation details instead of silently overwriting history

Namespace conventions:
- "@official" — curated by the platform team
- "@<org-name>" — scoped to an organization (e.g. "@acme")
- omit or leave empty — personal genome (default)`,
        title: 'Create / Update Genome',
        inputSchema: {
            name: z.string().describe('Short human-readable name for this genome, e.g. "Senior TypeScript Implementer"'),
            spec: z.string().describe('JSON-serialized GenomeSpec: { systemPrompt, tools?, modelId?, permissionMode?, seedContext? }'),
            description: z.string().optional().describe('Longer explanation of what this genome is optimized for'),
            teamId: z.string().optional().describe('Scope the genome to a specific team (null = personal/public)'),
            isPublic: z.boolean().default(false).describe('Whether other users can discover and use this genome'),
            id: z.string().optional().describe('Existing genome ID to update. Omit to create a new genome.'),
            namespace: z.string().optional().describe('Namespace scope: "@official", "@<org-name>", or omit for personal'),
            tags: z.string().optional().describe('JSON-serialized string array of discovery tags, e.g. \'["typescript","backend","testing"]\''),
            category: z.string().optional().describe('Genome category for browsing, e.g. "coding", "research", "devops", "writing"'),
        },
    }, async (args) => {
        try {
            const sessionId = client.sessionId;
            if (!sessionId) {
                return {
                    content: [{ type: 'text', text: 'Error: No session ID available.' }],
                    isError: true,
                };
            }

            const result = await api.createGenome({
                id: args.id,
                name: args.name,
                description: args.description,
                spec: args.spec,
                parentSessionId: sessionId,
                teamId: args.teamId,
                isPublic: args.isPublic,
                namespace: args.namespace,
                tags: args.tags,
                category: args.category,
            });

            return {
                content: [{ type: 'text', text: JSON.stringify({ success: true, genome: result.genome }) }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error creating genome: ${String(error)}` }],
                isError: true,
            };
        }
    });

    // ========== End Agent Spawning Tools ==========

    return mcp;

    }; // end createMcpInstance

    //
    // Create the HTTP server
    // MCP SDK 1.26.0 stateless mode requires a new transport + server per request.
    // See: simpleStatelessStreamableHttp.js in @modelcontextprotocol/sdk examples.
    //

    const server = createServer(async (req, res) => {
        try {
            const mcp = createMcpInstance();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolNames: [
            'change_title',
            'send_team_message',
            'get_context_status',
            'get_team_info',
            'create_task',
            'update_task',
            'delete_task',
            'list_tasks',
            // 嵌套任务工具 (v2)
            'create_subtask',
            'list_subtasks',
            'start_task',
            'complete_task',
            'report_blocker',
            'resolve_blocker',
            // Agent spawning tools
            'list_available_agents',
            'create_agent',
            'list_team_agents',
            'request_help',
            // Evolution system (M3)
            'create_genome',
            // Supervisor-only tools
            'read_team_log',
            'read_cc_log',
            'list_team_cc_logs',
            'list_team_runtime_logs',
            'read_runtime_log',
            'score_agent',
            'score_supervisor_self',
            'update_genome_feedback',
            'compact_agent',
            'kill_agent',
            'save_supervisor_state'
        ],
        stop: () => {
            logger.debug('[ahaMCP] Stopping server');
            server.close();
        }
    }
}
