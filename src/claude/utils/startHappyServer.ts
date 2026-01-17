/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { TEAM_ROLE_LIBRARY } from '@happy/shared-team-config';

export async function startHappyServer(api: any, client: ApiSessionClient) {
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
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

    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
        description: "Happy CLI MCP server with chat session management tools",
    });

    //
    // Context Resources (Rules & Preferences)
    //

    // Rules Resource
    mcp.registerResource(
        "happy://context/rules",
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
        "happy://context/preferences",
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
        logger.debug('[happyMCP] Response:', response);

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
            const teamId = metadata?.teamId;
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
            const teamId = metadata?.teamId;
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
            let teamMembers: any[] = [];
            try {
                const artifact = await api.getArtifact(teamId);

                // Try to get members from the board data first
                let board: any = null;
                if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                    try {
                        board = JSON.parse(artifact.body.body);
                    } catch (e) { /* ignore */ }
                } else {
                    board = artifact.body;
                }

                if (board && board.team && Array.isArray(board.team.members)) {
                    teamMembers = board.team.members;
                } else if (artifact.header && Array.isArray(artifact.header.sessions)) {
                    // Fallback to header sessions if available
                    teamMembers = artifact.header.sessions.map((sid: string) => ({ sessionId: sid }));
                }
            } catch (e) {
                logger.debug('[happyMCP] Failed to fetch team artifact:', e);
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

            // Fallback for unknown roles
            if (!roleDefinitions[myRole || '']) {
                roleDefinitions[myRole || ''] = { title: 'Unassigned', responsibilities: [], boundaries: [] };
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
                teamMembers: teamMembers.map(m => ({
                    sessionId: m.sessionId,
                    role: m.role || 'unknown',
                    displayName: m.displayName
                })),
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

    // Create Task
    mcp.registerTool('create_task', {
        description: 'Create a new task for the team. Use this to assign work to team members. ONLY MASTER role can use this.',
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
            const teamId = metadata?.teamId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to create tasks.' }], isError: true };
            }

            // Role Check: Only Master can create tasks
            if (role !== 'master') {
                return { content: [{ type: 'text', text: 'Error: Only the MASTER role can create tasks. Please ask the Master to create this task.' }], isError: true };
            }

            // 1. Fetch Team Artifact
            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: `Error: Failed to fetch team artifact ${teamId}.` }], isError: true };
            }

            // Parse board data correctly (handle { body: string } wrapper)
            let board: any = { tasks: [], columns: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try {
                    board = JSON.parse(artifact.body.body);
                } catch (e) { /* ignore */ }
            } else if (artifact.body) {
                board = artifact.body;
            }

            if (!board.tasks) board.tasks = [];

            const taskId = randomUUID();

            const task = {
                id: taskId,
                title: args.title,
                description: args.description || '',
                status: 'todo',
                assigneeId: args.assigneeId || null,
                reporterId: client.sessionId,
                priority: args.priority || 'medium',
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            board.tasks.push(task);

            // 2. Save Artifact
            try {
                // Wrap board back into { body: string } structure
                const newBody = {
                    body: JSON.stringify(board)
                };

                await api.updateArtifact(
                    teamId,
                    artifact.header, // Preserve existing header metadata
                    newBody,
                    artifact.headerVersion, // Use actual header version for optimistic locking
                    artifact.bodyVersion // Optimistic locking for body
                );
            } catch (e) {
                return { content: [{ type: 'text', text: `Error: Failed to save task to team board. Version mismatch or network error.` }], isError: true };
            }

            // 3. Notify Team
            try {
                const notification = {
                    id: randomUUID(),
                    teamId,
                    content: `🆕 **New Task Created**: ${task.title}\nAssignee: ${args.assigneeId || 'None'}\nPriority: ${task.priority}`,
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
                content: [{ type: 'text', text: `Task created successfully. ID: ${taskId}` }],
                isError: false,
            };

        } catch (error) {
            return { content: [{ type: 'text', text: `Error creating task: ${String(error)}` }], isError: true };
        }
    });

    // Update Task
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
            const teamId = metadata?.teamId;
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

            // 1. Fetch Team Artifact
            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: `Error: Failed to fetch team artifact ${teamId}.` }], isError: true };
            }

            // Parse board data correctly
            let board: any = null;
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try {
                    board = JSON.parse(artifact.body.body);
                } catch (e) { /* ignore */ }
            } else {
                board = artifact.body;
            }

            if (!board || !board.tasks) {
                return { content: [{ type: 'text', text: `Error: Team board is empty or invalid.` }], isError: true };
            }

            const taskIndex = board.tasks.findIndex((t: any) => t.id === args.taskId);
            if (taskIndex === -1) {
                return { content: [{ type: 'text', text: `Error: Task ${args.taskId} not found.` }], isError: true };
            }

            const task = board.tasks[taskIndex];
            const oldStatus = task.status;

            const normalizedStatus = args.status;

            if (isWorker) {
                const assignedToSelf = task.assigneeId === sessionId;
                const claimingSelf = !task.assigneeId && args.assigneeId === sessionId;

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

            // Permission Check (Optional but good):
            // Workers should only update tasks assigned to them or unassigned ones they are picking up (if allowed)
            // But for now, we trust the team protocol.

            // Apply updates
            if (normalizedStatus) task.status = normalizedStatus;
            if (args.assigneeId) task.assigneeId = args.assigneeId;
            if (args.priority) task.priority = args.priority;
            if (args.comment) {
                task.comments = task.comments || [];
                task.comments.push({
                    authorId: client.sessionId,
                    role: role,
                    content: args.comment,
                    timestamp: Date.now()
                });
            }
            task.updatedAt = Date.now();

            // 2. Save Artifact
            try {
                // Wrap board back into { body: string } structure
                const newBody = {
                    body: JSON.stringify(board)
                };

                await api.updateArtifact(
                    teamId,
                    artifact.header, // Preserve existing header metadata
                    newBody,
                    artifact.headerVersion, // Use actual header version for optimistic locking
                    artifact.bodyVersion // Optimistic locking for body
                );
            } catch (e) {
                return { content: [{ type: 'text', text: `Error: Failed to save task update. Someone else might have updated the board.` }], isError: true };
            }

            // 3. Notify Team
            try {
                let updateMsg = `🔄 **Task Updated**: ${task.title}`;
                if (normalizedStatus && normalizedStatus !== oldStatus) {
                    updateMsg += `\nStatus: ${oldStatus} → ${normalizedStatus}`;
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

    // List Tasks
    mcp.registerTool('list_tasks', {
        description: 'List all tasks for the current team.',
        title: 'List Tasks',
        inputSchema: {
            status: z.enum(['todo', 'in-progress', 'review', 'done']).optional().describe('Filter by status'),
            assigneeId: z.string().optional().describe('Filter by assignee'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to list tasks.' }], isError: true };
            }

            // Role Check removed: All team members should be able to see the board.
            // if (role !== 'master') {
            //     return { content: [{ type: 'text', text: 'Error: Only the MASTER role can list tasks. Ask the master for the current backlog.' }], isError: true };
            // }

            // 1. Fetch Team Artifact
            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: `Error: Failed to fetch team artifact ${teamId}.` }], isError: true };
            }

            // Parse board data correctly
            let board: any = null;
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try {
                    board = JSON.parse(artifact.body.body);
                } catch (e) { /* ignore */ }
            } else {
                board = artifact.body;
            }

            if (!board || !board.tasks) {
                return { content: [{ type: 'text', text: 'No tasks found (board is empty).' }], isError: false };
            }

            let tasks = board.tasks;

            // Filter
            if (args.status) {
                const normalizedStatus = args.status;
                tasks = tasks.filter((t: any) => t.status === normalizedStatus);
            }
            if (args.assigneeId) {
                tasks = tasks.filter((t: any) => t.assigneeId === args.assigneeId);
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error listing tasks: ${String(error)}` }], isError: true };
        }
    });

    // ========== 嵌套任务工具 (v2) ==========

    // Create Subtask - 创建子任务
    mcp.registerTool('create_subtask', {
        description: 'Create a subtask under an existing task. Use this to break down complex tasks into smaller, manageable pieces. ONLY MASTER role can create subtasks.',
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
            const teamId = metadata?.teamId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to create subtasks.' }], isError: true };
            }

            if (role !== 'master') {
                return { content: [{ type: 'text', text: 'Error: Only the MASTER role can create subtasks.' }], isError: true };
            }

            // Fetch artifact and parse board
            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: `Error: Failed to fetch team artifact.` }], isError: true };
            }

            let board: any = { tasks: [], columns: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try { board = JSON.parse(artifact.body.body); } catch (e) { /* ignore */ }
            } else if (artifact.body) {
                board = artifact.body;
            }
            if (!board.tasks) board.tasks = [];

            const parentTask = board.tasks.find((t: any) => t.id === args.parentTaskId);
            if (!parentTask) {
                return { content: [{ type: 'text', text: `Error: Parent task ${args.parentTaskId} not found.` }], isError: true };
            }

            const parentDepth = parentTask.depth ?? 0;
            if (parentDepth >= 3) {
                return { content: [{ type: 'text', text: 'Error: Maximum nesting depth (3) reached.' }], isError: true };
            }

            const subtaskId = randomUUID();
            const subtask = {
                id: subtaskId,
                title: args.title,
                description: args.description || '',
                status: 'todo',
                assigneeId: args.assigneeId ?? parentTask.assigneeId ?? null,
                reporterId: client.sessionId,
                priority: args.priority ?? parentTask.priority ?? 'medium',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                parentTaskId: args.parentTaskId,
                subtaskIds: [],
                depth: parentDepth + 1,
                statusPropagation: {
                    autoCompleteParent: true,
                    blockParentOnBlocked: true,
                    cascadeDeleteSubtasks: false
                }
            };

            board.tasks.push(subtask);
            parentTask.subtaskIds = parentTask.subtaskIds || [];
            parentTask.subtaskIds.push(subtaskId);
            parentTask.updatedAt = Date.now();

            // If parent is todo, move to in-progress
            if (parentTask.status === 'todo') {
                parentTask.status = 'in-progress';
            }

            // Save
            try {
                const newBody = { body: JSON.stringify(board) };
                await api.updateArtifact(teamId, artifact.header, newBody, artifact.headerVersion, artifact.bodyVersion);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to save subtask.' }], isError: true };
            }

            // Notify team
            try {
                await api.sendTeamMessage(teamId, {
                    id: randomUUID(),
                    teamId,
                    content: `📌 Subtask created under "${parentTask.title}":\n• ${subtask.title}\nAssignee: ${subtask.assigneeId || 'Unassigned'}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: role,
                    mentions: subtask.assigneeId ? [subtask.assigneeId] : []
                });
            } catch (e) { logger.debug('Failed to send subtask notification', e); }

            return {
                content: [{ type: 'text', text: `Subtask created successfully.\nID: ${subtaskId}\nParent: ${parentTask.title}\nDepth: ${subtask.depth}` }],
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
            const teamId = metadata?.teamId;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to fetch team artifact.' }], isError: true };
            }

            let board: any = { tasks: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try { board = JSON.parse(artifact.body.body); } catch (e) { /* ignore */ }
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

    // Start Task - 开始执行任务（创建执行链接）
    mcp.registerTool('start_task', {
        description: 'Mark a task as actively being worked on by you. Creates an execution link between your session and the task.',
        title: 'Start Task',
        inputSchema: {
            taskId: z.string().describe('ID of the task to start'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to fetch team artifact.' }], isError: true };
            }

            let board: any = { tasks: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try { board = JSON.parse(artifact.body.body); } catch (e) { /* ignore */ }
            } else if (artifact.body) {
                board = artifact.body;
            }

            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            if (!task) {
                return { content: [{ type: 'text', text: `Task ${args.taskId} not found.` }], isError: true };
            }

            // Check if task is assigned to this session
            if (task.assigneeId && task.assigneeId !== client.sessionId && role !== 'master') {
                return { content: [{ type: 'text', text: `Error: Task is assigned to another session.` }], isError: true };
            }

            // Check if already has an active link from another session
            const existingActive = task.executionLinks?.find((l: any) => l.status === 'active');
            if (existingActive && existingActive.sessionId !== client.sessionId) {
                return { content: [{ type: 'text', text: `Task is already being executed by session ${existingActive.sessionId.substring(0, 8)}...` }], isError: true };
            }

            // Add execution link
            task.executionLinks = task.executionLinks || [];
            task.executionLinks.push({
                sessionId: client.sessionId,
                linkedAt: Date.now(),
                role: 'primary',
                status: 'active'
            });

            if (task.status === 'todo') {
                task.status = 'in-progress';
            }
            task.updatedAt = Date.now();

            // Save
            try {
                const newBody = { body: JSON.stringify(board) };
                await api.updateArtifact(teamId, artifact.header, newBody, artifact.headerVersion, artifact.bodyVersion);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to save task update.' }], isError: true };
            }

            return {
                content: [{ type: 'text', text: `Started working on: "${task.title}"\nStatus: ${task.status}` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error starting task: ${String(error)}` }], isError: true };
        }
    });

    // Complete Task - 完成任务（触发状态传播）
    mcp.registerTool('complete_task', {
        description: 'Mark a task as complete. If all subtasks of a parent are done, the parent will automatically move to review.',
        title: 'Complete Task',
        inputSchema: {
            taskId: z.string().describe('ID of the task to complete'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to fetch team artifact.' }], isError: true };
            }

            let board: any = { tasks: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try { board = JSON.parse(artifact.body.body); } catch (e) { /* ignore */ }
            } else if (artifact.body) {
                board = artifact.body;
            }

            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            if (!task) {
                return { content: [{ type: 'text', text: `Task ${args.taskId} not found.` }], isError: true };
            }

            // Check for incomplete subtasks
            if (task.subtaskIds?.length) {
                const subtasks = board.tasks.filter((t: any) => task.subtaskIds.includes(t.id));
                const incomplete = subtasks.filter((st: any) => st.status !== 'done');
                if (incomplete.length > 0) {
                    return {
                        content: [{ type: 'text', text: `Cannot complete: ${incomplete.length} subtask(s) still pending:\n${incomplete.map((st: any) => `• ${st.title} (${st.status})`).join('\n')}` }],
                        isError: true
                    };
                }
            }

            // Update execution link
            const activeLink = task.executionLinks?.find((l: any) => l.sessionId === client.sessionId && l.status === 'active');
            if (activeLink) {
                activeLink.status = 'completed';
            }

            task.status = 'done';
            task.updatedAt = Date.now();

            const propagatedTasks: string[] = [args.taskId];

            // Propagate to parent
            const propagateToParent = (parentId: string) => {
                const parent = board.tasks.find((t: any) => t.id === parentId);
                if (!parent) return;

                const subtasks = board.tasks.filter((t: any) => parent.subtaskIds?.includes(t.id));
                const allDone = subtasks.every((st: any) => st.status === 'done');

                if (allDone && parent.status !== 'done' && parent.status !== 'review') {
                    parent.status = 'review';
                    parent.updatedAt = Date.now();
                    propagatedTasks.push(parentId);

                    if (parent.parentTaskId) {
                        propagateToParent(parent.parentTaskId);
                    }
                }
            };

            if (task.parentTaskId) {
                propagateToParent(task.parentTaskId);
            }

            // Save
            try {
                const newBody = { body: JSON.stringify(board) };
                await api.updateArtifact(teamId, artifact.header, newBody, artifact.headerVersion, artifact.bodyVersion);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to save task update.' }], isError: true };
            }

            // Notify team
            try {
                await api.sendTeamMessage(teamId, {
                    id: randomUUID(),
                    teamId,
                    content: `✅ Task completed: "${task.title}"${propagatedTasks.length > 1 ? `\n📊 Parent tasks updated: ${propagatedTasks.length - 1}` : ''}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: role
                });
            } catch (e) { logger.debug('Failed to send completion notification', e); }

            return {
                content: [{ type: 'text', text: `Task "${task.title}" completed.\nPropagated to ${propagatedTasks.length - 1} parent task(s).` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error completing task: ${String(error)}` }], isError: true };
        }
    });

    // Report Blocker - 报告阻塞
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
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to fetch team artifact.' }], isError: true };
            }

            let board: any = { tasks: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try { board = JSON.parse(artifact.body.body); } catch (e) { /* ignore */ }
            } else if (artifact.body) {
                board = artifact.body;
            }

            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            if (!task) {
                return { content: [{ type: 'text', text: `Task ${args.taskId} not found.` }], isError: true };
            }

            const blockerId = randomUUID();
            const blocker = {
                id: blockerId,
                type: args.type,
                description: args.description,
                raisedAt: Date.now(),
                raisedBy: client.sessionId
            };

            task.blockers = task.blockers || [];
            task.blockers.push(blocker);
            task.status = 'blocked';
            task.updatedAt = Date.now();

            // Propagate hasBlockedChild to parents
            const propagateBlocker = (parentId: string) => {
                const parent = board.tasks.find((t: any) => t.id === parentId);
                if (!parent) return;
                parent.hasBlockedChild = true;
                parent.updatedAt = Date.now();
                if (parent.parentTaskId) {
                    propagateBlocker(parent.parentTaskId);
                }
            };

            if (task.parentTaskId) {
                propagateBlocker(task.parentTaskId);
            }

            // Save
            try {
                const newBody = { body: JSON.stringify(board) };
                await api.updateArtifact(teamId, artifact.header, newBody, artifact.headerVersion, artifact.bodyVersion);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to save blocker.' }], isError: true };
            }

            // Notify Master with URGENT priority
            try {
                await api.sendTeamMessage(teamId, {
                    id: randomUUID(),
                    teamId,
                    content: `🚨 BLOCKER REPORTED\nTask: "${task.title}"\nType: ${args.type}\nDescription: ${args.description}\n\n@master Please address this blocker.`,
                    type: 'notification',
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: role,
                    metadata: { priority: 'urgent', blockerType: args.type }
                });
            } catch (e) { logger.debug('Failed to send blocker notification', e); }

            return {
                content: [{ type: 'text', text: `Blocker reported on "${task.title}".\nBlocker ID: ${blockerId}\nMaster has been notified.` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error reporting blocker: ${String(error)}` }], isError: true };
        }
    });

    // Resolve Blocker - 解决阻塞
    mcp.registerTool('resolve_blocker', {
        description: 'Resolve a blocker on a task. ONLY MASTER role can resolve blockers.',
        title: 'Resolve Blocker',
        inputSchema: {
            taskId: z.string().describe('ID of the task with the blocker'),
            blockerId: z.string().describe('ID of the blocker to resolve'),
            resolution: z.string().describe('How the blocker was resolved'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team.' }], isError: true };
            }

            if (role !== 'master') {
                return { content: [{ type: 'text', text: 'Error: Only the MASTER role can resolve blockers.' }], isError: true };
            }

            let artifact;
            try {
                artifact = await api.getArtifact(teamId);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to fetch team artifact.' }], isError: true };
            }

            let board: any = { tasks: [] };
            if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                try { board = JSON.parse(artifact.body.body); } catch (e) { /* ignore */ }
            } else if (artifact.body) {
                board = artifact.body;
            }

            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            if (!task) {
                return { content: [{ type: 'text', text: `Task ${args.taskId} not found.` }], isError: true };
            }

            const blocker = task.blockers?.find((b: any) => b.id === args.blockerId);
            if (!blocker) {
                return { content: [{ type: 'text', text: `Blocker ${args.blockerId} not found.` }], isError: true };
            }

            blocker.resolvedAt = Date.now();
            blocker.resolvedBy = client.sessionId;
            blocker.resolution = args.resolution;

            // Check if there are other unresolved blockers
            const unresolvedBlockers = task.blockers?.filter((b: any) => !b.resolvedAt) || [];
            if (unresolvedBlockers.length === 0) {
                task.status = 'in-progress';
            }
            task.updatedAt = Date.now();

            // Update parent hasBlockedChild flags
            const updateParentBlockedStatus = (parentId: string) => {
                const parent = board.tasks.find((t: any) => t.id === parentId);
                if (!parent) return;

                const subtasks = board.tasks.filter((t: any) => parent.subtaskIds?.includes(t.id));
                const hasBlockedSubtask = subtasks.some((st: any) => st.status === 'blocked' || st.hasBlockedChild);

                parent.hasBlockedChild = hasBlockedSubtask;
                parent.updatedAt = Date.now();

                if (parent.parentTaskId) {
                    updateParentBlockedStatus(parent.parentTaskId);
                }
            };

            if (task.parentTaskId) {
                updateParentBlockedStatus(task.parentTaskId);
            }

            // Save
            try {
                const newBody = { body: JSON.stringify(board) };
                await api.updateArtifact(teamId, artifact.header, newBody, artifact.headerVersion, artifact.bodyVersion);
            } catch (e) {
                return { content: [{ type: 'text', text: 'Error: Failed to save blocker resolution.' }], isError: true };
            }

            // Notify the original reporter
            try {
                await api.sendTeamMessage(teamId, {
                    id: randomUUID(),
                    teamId,
                    content: `✅ Blocker resolved on "${task.title}"\nResolution: ${args.resolution}\nTask is now: ${task.status}`,
                    type: 'task-update',
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: role,
                    mentions: blocker.raisedBy ? [blocker.raisedBy] : []
                });
            } catch (e) { logger.debug('Failed to send resolution notification', e); }

            return {
                content: [{ type: 'text', text: `Blocker resolved on "${task.title}".\nTask status: ${task.status}` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error resolving blocker: ${String(error)}` }], isError: true };
        }
    });

    // ========== End 嵌套任务工具 ==========

    const transport = new StreamableHTTPServerTransport({
        // NOTE: Returning session id here will result in claude
        // sdk spawn to fail with `Invalid Request: Server already initialized`
        sessionIdGenerator: undefined
    });
    await mcp.connect(transport);

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
            await transport.handleRequest(req, res);
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
            'get_team_info',
            'create_task',
            'update_task',
            'list_tasks',
            // 嵌套任务工具 (v2)
            'create_subtask',
            'list_subtasks',
            'start_task',
            'complete_task',
            'report_blocker',
            'resolve_blocker'
        ],
        stop: () => {
            logger.debug('[happyMCP] Stopping server');
            mcp.close();
            server.close();
        }
    }
}
