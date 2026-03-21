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
    canSpawnAgents,
    hasTeamAuthority,
} from '@/claude/team/roles';
import { writeScore } from '@/claude/utils/scoreStorage';
import { aggregateScores } from '@/claude/utils/feedbackPrivacy';
import { createTeamMemberIdentity } from './teamMemberIdentity';
import { ensureCurrentSessionRegisteredToTeam } from '../team/ensureTeamMembership';
import { readRuntimeLog, resolveTeamRuntimeLogs } from './runtimeLogReader';
import {
    resolveFeedbackUploadTarget,
    scoreMatchesFeedbackTarget,
} from './supervisorGenomeFeedback';
import { syncGenomeFeedbackToMarketplace } from './genomeFeedbackSync';
import {
    publishTeamCorpsTemplate,
    resolvePreferredGenomeSpecId,
    searchMarketplaceGenomes,
} from '@/utils/genomeMarketplace';
import { getContextStatusReport } from './contextStatus';
import { emitTraceEvent, emitTraceLink } from '@/trace/traceEmitter';
import { TraceEventKind } from '@/trace/traceTypes';

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

    const parseBoardFromArtifact = (artifact: any): any => {
        if (!artifact) return null;
        if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
            const bodyValue = (artifact.body as { body?: unknown }).body;
            if (typeof bodyValue === 'string') {
                try {
                    return JSON.parse(bodyValue);
                } catch {
                    return null;
                }
            }
            if (bodyValue && typeof bodyValue === 'object') {
                return bodyValue;
            }
        }
        if (artifact.body && typeof artifact.body === 'object') {
            return artifact.body;
        }
        return null;
    };

    const getCurrentTeamMemberContext = async (teamId: string): Promise<{
        board: any | null;
        member: any | null;
        authorities: string[];
        teamOverlay: any | null;
        effectiveGenome: any;
    }> => {
        const metadata = client.getMetadata();
        const taskManager = getTaskStateManager();

        if (taskManager) {
            await taskManager.getBoard().catch(() => null);
        }

        const artifact = await api.getArtifact(teamId).catch(() => null);
        const board = parseBoardFromArtifact(artifact);
        const members = Array.isArray(board?.team?.members) ? board.team.members : [];
        const member = members.find((candidate: any) => {
            if (!candidate || typeof candidate !== 'object') return false;
            if (metadata?.memberId && candidate.memberId) {
                return candidate.memberId === metadata.memberId;
            }
            return candidate.sessionId === client.sessionId;
        }) ?? members.find((candidate: any) => candidate?.sessionId === client.sessionId) ?? null;

        const teamOverlay = member?.teamOverlay ?? null;
        const authoritySet = new Set<string>([
            ...((genomeSpecRef?.current as any)?.authorities ?? []),
            ...(Array.isArray(member?.authorities) ? member.authorities : []),
            ...(Array.isArray(teamOverlay?.authorities) ? teamOverlay.authorities : []),
        ]);

        const effectiveGenome = {
            ...(genomeSpecRef?.current ?? {}),
            authorities: Array.from(authoritySet),
        };

        return {
            board,
            member,
            authorities: Array.from(authoritySet),
            teamOverlay,
            effectiveGenome,
        };
    };

    const HELP_MENTION_RE = /(^|[^a-zA-Z0-9_])@help\b/i;

    const toHelpSeverity = (priority?: 'normal' | 'high' | 'urgent'): 'low' | 'medium' | 'high' | 'critical' => {
        switch (priority) {
            case 'urgent':
                return 'critical';
            case 'high':
                return 'high';
            default:
                return 'medium';
        }
    };

    const containsHelpMention = (content: string): boolean => HELP_MENTION_RE.test(content.trim());

    const listDaemonTrackedSessions = async (): Promise<Array<{ ahaSessionId: string; pid: number }>> => {
        const daemonState = await readDaemonState();
        if (!daemonState?.httpPort) {
            return [];
        }

        const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(5_000),
        });

        const result = await response.json() as {
            children?: Array<{ ahaSessionId: string; pid: number }>;
        };

        return Array.isArray(result.children) ? result.children : [];
    };

    const getDaemonTrackedSessionIds = async (): Promise<Set<string>> => {
        const trackedSessions = await listDaemonTrackedSessions();
        return new Set(trackedSessions.map((session) => session.ahaSessionId));
    };

    type VoteDecision = 'keep' | 'replace' | 'unsure';

    const parseVoteDecision = (content: string): VoteDecision | null => {
        const match = content.toLowerCase().match(/\b(keep|replace|unsure)\b/);
        if (!match) return null;
        const decision = match[1];
        if (decision === 'keep' || decision === 'replace' || decision === 'unsure') {
            return decision;
        }
        return null;
    };

    const getTeamMemberRecord = async (teamId: string, sessionId: string): Promise<any | null> => {
        const teamResult = await api.getTeam(teamId);
        const members = Array.isArray(teamResult?.team?.members) ? teamResult.team.members : [];
        return members.find((member: any) => member?.sessionId === sessionId) ?? null;
    };

    const evaluateReplacementVotes = async (params: {
        teamId: string;
        targetSessionId: string;
        limit?: number;
        minVotes?: number;
    }): Promise<{
        counts: Record<VoteDecision, number>;
        votes: Array<{ fromSessionId: string; decision: VoteDecision; content: string; timestamp: number }>;
        totalVotes: number;
        quorumReached: boolean;
        recommendation: VoteDecision | 'no-decision';
    }> => {
        const messagesResult = await api.getTeamMessages(params.teamId, { limit: params.limit ?? 200 });
        const messages = Array.isArray(messagesResult?.messages) ? messagesResult.messages : [];
        const latestVoteBySession = new Map<string, { fromSessionId: string; decision: VoteDecision; content: string; timestamp: number }>();

        for (const message of messages) {
            if (message?.type !== 'vote') continue;
            const targetSessionId = message?.metadata?.targetSessionId;
            if (targetSessionId !== params.targetSessionId) continue;
            const decision = message?.metadata?.voteDecision || parseVoteDecision(String(message?.content || ''));
            if (decision !== 'keep' && decision !== 'replace' && decision !== 'unsure') continue;
            const fromSessionId = String(message?.fromSessionId || '');
            if (!fromSessionId || fromSessionId === params.targetSessionId) continue;

            const existing = latestVoteBySession.get(fromSessionId);
            if (!existing || Number(message?.timestamp || 0) >= existing.timestamp) {
                latestVoteBySession.set(fromSessionId, {
                    fromSessionId,
                    decision,
                    content: String(message?.content || ''),
                    timestamp: Number(message?.timestamp || 0),
                });
            }
        }

        const votes = Array.from(latestVoteBySession.values()).sort((left, right) => left.timestamp - right.timestamp);
        const counts = votes.reduce<Record<VoteDecision, number>>((acc, vote) => {
            acc[vote.decision] += 1;
            return acc;
        }, { keep: 0, replace: 0, unsure: 0 });

        const totalVotes = votes.length;
        const minVotes = params.minVotes ?? 2;
        const quorumReached = totalVotes >= minVotes && counts.replace > counts.keep;
        const recommendation: VoteDecision | 'no-decision' = quorumReached
            ? 'replace'
            : counts.keep >= minVotes && counts.keep > counts.replace
                ? 'keep'
                : 'no-decision';

        return { counts, votes, totalVotes, quorumReached, recommendation };
    };

    const spawnReplacementSession = async (params: {
        teamId: string;
        targetSessionId: string;
        roleId: string;
        displayName: string;
        directory: string;
        runtimeType: 'claude' | 'codex';
        executionPlane: 'mainline' | 'bypass';
        memberId?: string;
        specId?: string;
        parentSessionId?: string;
        modelId?: string;
        fallbackModelId?: string;
    }): Promise<{ sessionId: string; memberId: string; sessionTag: string; specId: string | null; specSource: string }> => {
        const daemonState = await readDaemonState();
        if (!daemonState?.httpPort) {
            throw new Error('Daemon is not running. Cannot replace agents without a running daemon.');
        }

        const { memberId, sessionTag } = createTeamMemberIdentity(params.teamId, params.memberId);
        const resolvedSpec = await resolvePreferredGenomeSpecId({
            role: params.roleId,
            runtime: params.runtimeType,
            strategy: 'best-rated',
            explicitSpecId: params.specId,
        });

        const spawnBody: Record<string, any> = {
            directory: params.directory,
            sessionTag,
            sessionName: params.displayName,
            role: params.roleId,
            teamId: params.teamId,
            agent: params.runtimeType,
            parentSessionId: params.parentSessionId || params.targetSessionId,
            executionPlane: params.executionPlane,
            env: {
                AHA_AGENT_LANGUAGE: process.env.AHA_AGENT_LANGUAGE || 'en',
                AHA_TEAM_MEMBER_ID: memberId,
                ...(params.modelId ? { AHA_AGENT_MODEL: params.modelId } : {}),
                ...(params.fallbackModelId ? { AHA_FALLBACK_AGENT_MODEL: params.fallbackModelId } : {}),
            },
        };

        if (params.runtimeType === 'codex') {
            const openAiToken = await api.getVendorToken('openai');
            if (openAiToken) {
                spawnBody.token = typeof openAiToken === 'string' ? openAiToken : JSON.stringify(openAiToken);
            }
        }

        if (resolvedSpec.specId) {
            spawnBody.specId = resolvedSpec.specId;
        }

        const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/spawn-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(spawnBody),
            signal: AbortSignal.timeout(15_000),
        });

        const result = await response.json() as { success?: boolean; sessionId?: string; error?: string };
        if (!response.ok || !result.success || !result.sessionId) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        await api.addTeamMember(
            params.teamId,
            result.sessionId,
            params.roleId,
            params.displayName,
            {
                memberId,
                sessionTag,
                specId: resolvedSpec.specId ?? undefined,
                parentSessionId: params.parentSessionId || params.targetSessionId,
                executionPlane: params.executionPlane,
                runtimeType: params.runtimeType,
            }
        );

        return {
            sessionId: result.sessionId,
            memberId,
            sessionTag,
            specId: resolvedSpec.specId,
            specSource: resolvedSpec.source,
        };
    };

    const triggerHelpLane = async (params: {
        teamId: string;
        sessionId: string;
        role?: string;
        type: 'stuck' | 'context_overflow' | 'need_collaborator' | 'error' | 'custom';
        description: string;
        severity: 'low' | 'medium' | 'high' | 'critical';
        taskId?: string;
        sendNotification?: boolean;
    }): Promise<{ helpSpawned: boolean; error?: string }> => {
        const {
            teamId,
            sessionId,
            role,
            type,
            description,
            severity,
            taskId,
            sendNotification = true,
        } = params;

        const listTeamSessionsViaDaemon = async (teamIdValue: string): Promise<Array<{
            ahaSessionId: string;
            claudeLocalSessionId?: string;
            runtimeType?: string;
            role?: string;
            pid: number;
        }>> => {
            const { daemonPost } = await import('@/daemon/controlClient');
            const result = await daemonPost('/list-team-sessions', { teamId: teamIdValue });
            return Array.isArray(result?.sessions) ? result.sessions : [];
        };

        const waitForHelpAgentActivation = async (teamIdValue: string, expectedSessionId?: string): Promise<boolean> => {
            if (!expectedSessionId) return false;
            const deadline = Date.now() + 8_000;
            while (Date.now() < deadline) {
                try {
                    const sessions = await listTeamSessionsViaDaemon(teamIdValue);
                    const match = sessions.find((session) =>
                        session.ahaSessionId === expectedSessionId && session.role === 'help-agent'
                    );
                    if (match) {
                        return true;
                    }
                } catch (error) {
                    logger.debug('[help-lane] Failed while verifying help-agent activation (non-fatal)', error);
                }
                await new Promise((resolve) => setTimeout(resolve, 350));
            }
            return false;
        };

        try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const eventsDir = path.join(process.cwd(), '.aha', 'events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const event = {
                timestamp: new Date().toISOString(),
                sessionId,
                teamId,
                role,
                type,
                description,
                severity,
                taskId,
            };

            const eventsFile = path.join(eventsDir, 'help_requests.jsonl');
            fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
        } catch (error) {
            logger.debug('[help-lane] Failed to persist help request event (non-fatal)', error);
        }

        if (sendNotification) {
            try {
                const severityEmoji = severity === 'critical' ? '🚨' : severity === 'high' ? '🆘' : '🙋';
                const shortDesc = description.length > 150 ? description.substring(0, 150) + '...' : description;
                await api.sendTeamMessage(teamId, {
                    id: randomUUID(),
                    teamId,
                    content: `${severityEmoji} Help requested (${type}, ${severity}): ${description}`,
                    shortContent: `${severityEmoji} Help: ${shortDesc}`,
                    type: 'notification',
                    timestamp: Date.now(),
                    fromSessionId: sessionId,
                    fromRole: role,
                    metadata: { helpType: type, severity, taskId },
                });
            } catch (error) {
                logger.debug('[help-lane] Failed to send help request notification (non-fatal)', error);
            }
        }

        try {
            const { updateSupervisorRun } = await import('@/daemon/supervisorState');
            await updateSupervisorRun(teamId, {
                pendingAction: {
                    type: 'notify_help',
                    message: `[${severity}] ${description}`,
                    requestType: type,
                    severity,
                    description,
                    targetSessionId: sessionId,
                },
                pendingActionMeta: null,
            });
            logger.debug(`[help-lane] pendingAction saved for team ${teamId}`);
        } catch (error) {
            logger.debug('[help-lane] Failed to save pendingAction (non-fatal)', error);
        }

        // Deduplication: skip spawn if there's already an active help-agent in the team
        try {
            const activeSessions = await listTeamSessionsViaDaemon(teamId);
            const activeHelpAgent = activeSessions.find((s) => s.role === 'help-agent');
            if (activeHelpAgent) {
                logger.debug(`[help-lane] Active help-agent already present (${activeHelpAgent.ahaSessionId}) — skipping duplicate spawn for team ${teamId}`);
                return { helpSpawned: false, error: 'help-agent already active' };
            }
        } catch (error) {
            logger.debug('[help-lane] Failed to check for active help-agents (non-fatal)', error);
        }

        let lastError = 'unknown error';
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const { daemonPost } = await import('@/daemon/controlClient');
                const helpResult = await daemonPost('/help-request', {
                    teamId,
                    sessionId,
                    type,
                    description,
                    severity,
                });

                if (helpResult && !helpResult.error) {
                    const helpAgentSessionId = typeof helpResult.helpAgentSessionId === 'string'
                        ? helpResult.helpAgentSessionId
                        : undefined;
                    const confirmed = await waitForHelpAgentActivation(teamId, helpAgentSessionId);

                    if (confirmed) {
                        try {
                            const { updateSupervisorRun } = await import('@/daemon/supervisorState');
                            await updateSupervisorRun(teamId, {
                                pendingAction: null,
                                pendingActionMeta: null,
                            });
                        } catch (error) {
                            logger.debug('[help-lane] Failed to clear pendingAction after confirmed help spawn (non-fatal)', error);
                        }
                        if (sendNotification) {
                            try {
                                await api.sendTeamMessage(teamId, {
                                    id: randomUUID(),
                                    teamId,
                                    content: `🛠️ Help-agent confirmed for ${sessionId}. Session ${helpAgentSessionId} is now active for ${type} (${severity}).`,
                                    shortContent: `🛠️ Help-agent confirmed: ${type} (${severity})`,
                                    type: 'notification',
                                    timestamp: Date.now(),
                                    fromSessionId: sessionId,
                                    fromRole: role,
                                    metadata: {
                                        helpType: type,
                                        severity,
                                        taskId,
                                        helpAgentSessionId,
                                    },
                                });
                            } catch (error) {
                                logger.debug('[help-lane] Failed to post help-agent confirmation notification (non-fatal)', error);
                            }
                        }
                        logger.debug(`[help-lane] Help-agent spawned and confirmed via daemon on attempt ${attempt}: ${JSON.stringify(helpResult)}`);
                        return { helpSpawned: true };
                    }

                    lastError = helpAgentSessionId
                        ? `help-agent ${helpAgentSessionId} spawn returned success but was not observable in team runtime sessions`
                        : 'help-agent spawn returned success without a session id';
                    logger.debug(`[help-lane] Help-agent spawn was not confirmed on attempt ${attempt}: ${lastError}`);
                    continue;
                }

                lastError = helpResult?.error || 'unknown error';
                logger.debug(`[help-lane] Daemon help-request attempt ${attempt} failed: ${lastError}`);
            } catch (error) {
                lastError = String(error);
                logger.debug(`[help-lane] Failed to spawn help-agent via daemon on attempt ${attempt} (non-fatal)`, error);
            }

            if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }

        try {
            const { getPendingActionRetryDelayMs, updateSupervisorRun } = await import('@/daemon/supervisorState');
            const retryBaseMs = Math.max(
                parseInt(process.env.AHA_DAEMON_HEARTBEAT_INTERVAL || '60000'),
                parseInt(process.env.AHA_SUPERVISOR_PENDING_ACTION_RETRY_BASE_MS || '60000'),
            );
            await updateSupervisorRun(teamId, {
                pendingActionMeta: {
                    retryCount: 0,
                    lastAttemptAt: Date.now(),
                    nextRetryAt: Date.now() + getPendingActionRetryDelayMs(0, retryBaseMs),
                    lastError,
                },
            });
            logger.debug(`[help-lane] Scheduled pendingAction retry for team ${teamId}`);
        } catch (error) {
            logger.debug('[help-lane] Failed to persist pendingAction retry schedule (non-fatal)', error);
        }

        return { helpSpawned: false, error: lastError };
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
                mentions: args.mentions,
                metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
            };

            await api.sendTeamMessage(teamId, message);

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

            const { effectiveGenome } = await getCurrentTeamMemberContext(teamId);
            if (!canCreateTeamTasks(role, effectiveGenome)) {
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

            // ── Trace: task_created ─────────────────────────────────────
            try {
                emitTraceEvent(
                    TraceEventKind.task_created,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: result.task.id,
                        session_id: client.sessionId,
                    },
                    `Task "${result.task.title}" created (priority=${result.task.priority}, assignee=${args.assigneeId || 'none'})`,
                    { attrs: { title: result.task.title, assigneeId: args.assigneeId } },
                );
            } catch { /* trace must never break main flow */ }

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
        description: 'Update an existing task\'s status, assignee, or details. If you are changing review state, handing work off, or making a decision another agent must inherit, include a comment so the task carries memory with it.',
        title: 'Update Task',
        inputSchema: {
            taskId: z.string().describe('The ID of the task to update'),
            status: z.enum(['todo', 'in-progress', 'review', 'done']).optional().describe('New status'),
            assigneeId: z.string().optional().describe('New assignee Session ID'),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('New priority'),
            comment: z.string().optional().describe('Add a comment/note to the task'),
            commentType: z.enum(['note', 'status-change', 'review-feedback', 'handoff', 'decision']).optional().describe('Optional structured comment type'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            // Check both teamId and roomId - roomId is used for team artifacts from AHA_ROOM_ID env
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const sessionId = client.sessionId;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to update tasks.' }], isError: true };
            }

            const { authorities } = await getCurrentTeamMemberContext(teamId);
            const hasTeamWideTaskWrite =
                hasTeamAuthority(authorities, 'task.update.any')
                || hasTeamAuthority(authorities, 'task.assign')
                || hasTeamAuthority(authorities, 'task.create')
                || hasTeamAuthority(authorities, 'task.approve');
            const isRestrictedWorker = !hasTeamWideTaskWrite;
            const isReviewer = role === 'reviewer' && !hasTeamWideTaskWrite;

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
            if (isRestrictedWorker) {
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
            if (args.comment) {
                updates.comment = {
                    sessionId,
                    role,
                    displayName: metadata?.displayName || metadata?.name,
                    type: args.commentType || (
                        args.assigneeId ? 'handoff'
                            : args.status === 'review' ? 'review-feedback'
                                : args.status ? 'status-change'
                                    : 'note'
                    ),
                    content: args.comment,
                    fromStatus: undefined,
                    toStatus: args.status,
                    mentions: args.assigneeId ? [args.assigneeId] : undefined,
                };
            }

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

    mcp.registerTool('add_task_comment', {
        description: 'Add persistent review/handoff memory to a task. Use this when feedback or rationale should stay attached to the task itself, not only in chat. Preferred for review notes, handoff rationale, blocker context, and decisions that the next agent must inherit.',
        title: 'Add Task Comment',
        inputSchema: {
            taskId: z.string().describe('The ID of the task to comment on'),
            content: z.string().describe('Comment text'),
            type: z.enum(['note', 'status-change', 'review-feedback', 'handoff', 'blocker', 'decision']).default('note').describe('Structured comment type'),
            mentions: z.array(z.string()).optional().describe('Optional session IDs to mention'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;

            if (!teamId) {
                return { content: [{ type: 'text', text: 'Error: You must be in a team to add task comments.' }], isError: true };
            }

            const result = await api.addTaskComment(teamId, args.taskId, {
                sessionId: client.sessionId,
                role,
                displayName: metadata?.displayName || metadata?.name,
                type: args.type,
                content: args.content,
                mentions: args.mentions,
            });

            if (!result.success || !result.task) {
                return { content: [{ type: 'text', text: 'Error: Failed to add task comment.' }], isError: true };
            }

            return {
                content: [{ type: 'text', text: `Comment added to task ${args.taskId}.` }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error adding task comment: ${String(error)}` }], isError: true };
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

            const { effectiveGenome } = await getCurrentTeamMemberContext(teamId);
            if (!canManageExistingTasks(role, effectiveGenome)) {
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
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const { effectiveGenome } = teamId
                ? await getCurrentTeamMemberContext(teamId)
                : { effectiveGenome: genomeSpecRef?.current ?? null };
            const isCoordinator = canManageExistingTasks(role, effectiveGenome);

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

            const { effectiveGenome } = await getCurrentTeamMemberContext(teamId);
            if (!canManageExistingTasks(role, effectiveGenome)) {
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
        description: 'Mark a task as actively being worked on by you. Creates an execution link between your session and the task. Add a comment if your planned approach or scope boundary would help future handoff/review.',
        title: 'Start Task',
        inputSchema: {
            taskId: z.string().describe('ID of the task to start'),
            comment: z.string().optional().describe('Optional note explaining what you are starting or how you will approach it'),
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
            const result = await taskManager.startTaskWithComment(args.taskId, args.comment ? {
                displayName: client.getMetadata()?.displayName || client.getMetadata()?.name,
                content: args.comment,
            } : undefined);

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            // Get task details for response
            const board = await taskManager.getBoard();
            const task = board.tasks?.find((t: any) => t.id === args.taskId);
            const taskTitle = task?.title || args.taskId;

            // ── Trace: task_started ─────────────────────────────────────
            try {
                const metadata = client.getMetadata();
                const teamId = metadata?.teamId || metadata?.roomId;
                emitTraceEvent(
                    TraceEventKind.task_started,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: args.taskId,
                        session_id: client.sessionId,
                    },
                    `Task "${taskTitle}" started by ${metadata?.role || 'unknown'}`,
                );
            } catch { /* trace must never break main flow */ }

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
        description: 'Mark a task as complete. If all subtasks of a parent are done, the parent will automatically move to review. Add a completion comment when reviewers need context about what changed or what to verify.',
        title: 'Complete Task',
        inputSchema: {
            taskId: z.string().describe('ID of the task to complete'),
            comment: z.string().optional().describe('Optional completion note summarizing what changed or what reviewers should check'),
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
            const result = await taskManager.completeTaskWithComment(args.taskId, args.comment ? {
                role: client.getMetadata()?.role,
                displayName: client.getMetadata()?.displayName || client.getMetadata()?.name,
                content: args.comment,
            } : undefined);

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            const propagatedCount = result.propagatedTasks?.length ? result.propagatedTasks.length - 1 : 0;

            // ── Trace: task_completed ────────────────────────────────────
            try {
                const metadata = client.getMetadata();
                const teamId = metadata?.teamId || metadata?.roomId;
                emitTraceEvent(
                    TraceEventKind.task_completed,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: args.taskId,
                        session_id: client.sessionId,
                    },
                    `Task "${taskTitle}" completed by ${metadata?.role || 'unknown'} (propagated to ${propagatedCount} parent(s))`,
                );
            } catch { /* trace must never break main flow */ }

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
        description: 'Report a blocker on a task. This will mark the task as blocked and notify the Master. Include enough context that another agent can inherit the task without re-discovering the blocker.',
        title: 'Report Blocker',
        inputSchema: {
            taskId: z.string().describe('ID of the blocked task'),
            type: z.enum(['dependency', 'question', 'resource', 'technical']).describe('Type of blocker'),
            description: z.string().describe('Detailed description of the blocker'),
            comment: z.string().optional().describe('Optional extra context, mitigation attempts, or handoff note'),
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
                args.description,
                {
                    role: client.getMetadata()?.role,
                    displayName: client.getMetadata()?.displayName || client.getMetadata()?.name,
                    mentions: undefined,
                    content: args.comment,
                }
            );

            if (!result.success) {
                return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
            }

            // ── Trace: task_blocked ──────────────────────────────────────
            try {
                const metadata = client.getMetadata();
                const teamId = metadata?.teamId || metadata?.roomId;
                emitTraceEvent(
                    TraceEventKind.task_blocked,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: args.taskId,
                        session_id: client.sessionId,
                    },
                    `Task "${taskTitle}" blocked (${args.type}): ${args.description.slice(0, 200)}`,
                    { status: 'blocked', attrs: { blockerType: args.type, blockerId: result.blockerId } },
                );
            } catch { /* trace must never break main flow */ }

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
        description: 'Resolve a blocker on a task. Coordinator roles can resolve blockers. Add a follow-up note when the assignee or reviewer needs to understand what changed.',
        title: 'Resolve Blocker',
        inputSchema: {
            taskId: z.string().describe('ID of the task with the blocker'),
            blockerId: z.string().describe('ID of the blocker to resolve'),
            resolution: z.string().describe('How the blocker was resolved'),
            comment: z.string().optional().describe('Optional follow-up note for the assignee or reviewer'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const role = metadata?.role;

            const teamId = metadata?.teamId || metadata?.roomId;
            const { effectiveGenome } = teamId
                ? await getCurrentTeamMemberContext(teamId)
                : { effectiveGenome: genomeSpecRef?.current ?? null };
            if (!canManageExistingTasks(role, effectiveGenome)) {
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
                args.resolution,
                args.comment ? {
                    role,
                    displayName: metadata?.displayName || metadata?.name,
                    type: 'decision',
                    content: args.comment,
                } : undefined
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
        description: `Browse the genome marketplace. Returns a compact directory of all available agents sorted by rating. Use like \`ls\` — scan the list, then use the id in create_agent to spawn one. Call without arguments to get the full catalog.`,
        title: 'List Available Agents',
        inputSchema: {
            query: z.string().optional().describe('Optional search query, e.g. a role, skill, or tag'),
            category: z.string().optional().describe("Optional filter: 'coordination' | 'implementation' | 'quality' | 'research' | 'support'"),
            limit: z.number().default(100).describe('Max results (default 100)'),
        },
    }, async (args) => {
        const metadata = client.getMetadata();
        const role = metadata?.role;
        const teamId = metadata?.teamId || metadata?.roomId;
        const { effectiveGenome } = teamId
            ? await getCurrentTeamMemberContext(teamId)
            : { effectiveGenome: genomeSpecRef?.current ?? null };
        const genomeAllows = effectiveGenome?.behavior?.canSpawnAgents;
        const allowed = genomeAllows !== undefined ? genomeAllows : canSpawnAgents(role, effectiveGenome);
        if (!allowed) {
            return { content: [{ type: 'text', text: 'Error: Your genome/role does not have permission to browse the agent marketplace.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
        try {
            const agents = (await searchMarketplaceGenomes({
                query: args.query,
                category: args.category,
                limit: args.limit ?? 100,
                hubUrl,
            }))
                .filter(g => g.category !== 'corps')
                .sort((left, right) => {
                    const leftTags = left.tags ? (() => { try { return JSON.parse(left.tags) as string[]; } catch { return []; } })() : [];
                    const rightTags = right.tags ? (() => { try { return JSON.parse(right.tags) as string[]; } catch { return []; } })() : [];
                    const leftSpecial = leftTags.some((tag) => {
                        const normalized = String(tag).toLowerCase();
                        return normalized.includes('special') || normalized.includes('agent-builder');
                    }) || left.name.toLowerCase().includes('agent-builder');
                    const rightSpecial = rightTags.some((tag) => {
                        const normalized = String(tag).toLowerCase();
                        return normalized.includes('special') || normalized.includes('agent-builder');
                    }) || right.name.toLowerCase().includes('agent-builder');

                    return Number(rightSpecial) - Number(leftSpecial);
                });

            if (agents.length === 0) {
                return { content: [{ type: 'text', text: args.query ? `No marketplace agents matched "${args.query}".` : 'Marketplace is empty.' }], isError: false };
            }

            // Compact directory: one line per genome, minimal tokens
            const lines = agents.map(g => {
                let fb: { avgScore?: number; evaluationCount?: number } = {};
                try { fb = g.feedbackData ? JSON.parse(g.feedbackData) : {}; } catch { /* */ }
                const parsedTags = g.tags ? (() => { try { return JSON.parse(g.tags!) as string[]; } catch { return []; } })() : [];
                const tags = parsedTags.join(',');
                const score = typeof fb.avgScore === 'number' ? `★${fb.avgScore}(${fb.evaluationCount})` : '';
                const spawns = g.spawnCount > 0 ? `${g.spawnCount}x` : '';
                const desc = (g.description ?? '').slice(0, 60);
                const special = parsedTags.some(tag => {
                    const normalized = tag.toLowerCase();
                    return normalized.includes('special') || normalized.includes('agent-builder');
                }) ? '[SPECIAL] ' : '';
                return `${special}${g.id} ${g.namespace ?? ''}/${g.name} ${score} ${spawns} [${tags}] ${desc}`.trim();
            });

            const header = `${agents.length} agents (sorted by score). Pass id to create_agent(specId=...) to spawn.${args.query ? ` Query="${args.query}".` : ''}`;
            return { content: [{ type: 'text', text: header + '\n' + lines.join('\n') }], isError: false };
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
   - agent-builder: Special genome architect. Spawn when the task is to create, refine, mutate, package, or publish agents/genomes. In those workflows, this is usually the first specialist after master.

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
            strategy: z.enum(['official', 'best-rated']).optional().describe('Spawn strategy: "best-rated" (default) searches the marketplace first and falls back to @official/{role}; "official" skips market search.'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const role = metadata?.role;
            const teamId = metadata?.teamId || metadata?.roomId;
            const { effectiveGenome } = teamId
                ? await getCurrentTeamMemberContext(teamId)
                : { effectiveGenome: genomeSpecRef?.current ?? null };

            // Genome spec is authoritative: behavior.canSpawnAgents overrides hardcode.
            const genomeAllows = effectiveGenome?.behavior?.canSpawnAgents;
            const allowed = genomeAllows !== undefined ? genomeAllows : canSpawnAgents(role, effectiveGenome);
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

            if (args.agent === 'codex') {
                const openAiToken = await api.getVendorToken('openai');
                if (openAiToken) {
                    spawnBody.token = typeof openAiToken === 'string'
                        ? openAiToken
                        : JSON.stringify(openAiToken);
                    logger.debug('[create_agent] Attached stored OpenAI token for Codex spawn');
                } else {
                    logger.debug('[create_agent] No stored OpenAI token found for Codex spawn; falling back to machine-local Codex auth');
                }
            }

            const specResolution = await resolvePreferredGenomeSpecId({
                role: args.role,
                runtime: args.agent || 'claude',
                strategy: args.strategy || 'best-rated',
                explicitSpecId: args.specId,
            });
            const resolvedSpecId = specResolution.specId;
            if (resolvedSpecId) {
                logger.debug(`[create_agent] Resolved specId=${resolvedSpecId} for role ${args.role} via ${specResolution.source}${specResolution.matchedName ? ` (${specResolution.matchedName})` : ''}`);
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

            // ── Trace: spawn_requested ──────────────────────────────────
            let spawnRequestedEventId: string | null = null;
            try {
                spawnRequestedEventId = emitTraceEvent(
                    TraceEventKind.spawn_requested,
                    'mcp',
                    {
                        team_id: args.teamId,
                        member_id: memberId,
                        session_id: client.sessionId,
                    },
                    `${role || 'unknown'} requested spawn of ${args.role} (runtime=${args.agent || 'claude'}) in team ${args.teamId}`,
                    { attrs: { role: args.role, runtime: args.agent || 'claude', specId: resolvedSpecId } },
                );
            } catch { /* trace must never break main flow */ }

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
            let publishedCorpsTemplate: Awaited<ReturnType<typeof publishTeamCorpsTemplate>> | null = null;
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

                    publishedCorpsTemplate = await publishTeamCorpsTemplate({
                        api,
                        teamId: args.teamId,
                        publisherId: client.sessionId,
                    });
                    if (publishedCorpsTemplate.published) {
                        logger.debug(`[create_agent] Published corps template ${publishedCorpsTemplate.templateName} for team ${args.teamId}`);
                    } else if (publishedCorpsTemplate.error) {
                        logger.debug(`[create_agent] Corps publish skipped/failed for team ${args.teamId}: ${publishedCorpsTemplate.error}`);
                    }
                } catch (memberError) {
                    logger.debug(`[create_agent] Warning: Failed to add to team roster: ${memberError}`);
                    // Don't fail the whole operation — agent is spawned, just not in roster yet
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        sessionId: spawnedSessionId,
                        memberId,
                        sessionTag,
                        role: args.role,
                        teamId: args.teamId,
                        specId: resolvedSpecId,
                        specSource: specResolution.source,
                        corpsTemplate: publishedCorpsTemplate?.published
                            ? {
                                templateName: publishedCorpsTemplate.templateName,
                                templateId: publishedCorpsTemplate.templateId,
                            }
                            : null,
                        status: 'spawned_and_registered',
                    })
                }],
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
            const daemonTrackedSessionIds = await getDaemonTrackedSessionIds().catch(() => new Set<string>());
            const sessionSnapshots = await Promise.all(
                Array.from(allSessionIds).map(async (sessionId: string) => {
                    try {
                        return [sessionId, await api.getSession(sessionId)] as const;
                    } catch {
                        return [sessionId, null] as const;
                    }
                })
            );
            const sessionSnapshotMap = new Map(sessionSnapshots);

            // Role definitions from shared config
            const roleDefinitions: Record<string, any> = {};
            TEAM_ROLE_LIBRARY.forEach((role: any) => {
                roleDefinitions[role.id] = { title: role.title };
            });

            const BYPASS_ROLE_IDS = ['supervisor', 'help-agent'];
            const agents = Array.from(allSessionIds).flatMap((sessionId: string) => {
                const member = memberMap.get(sessionId) as Record<string, any> | undefined;
                const sessionSnapshot = sessionSnapshotMap.get(sessionId);
                const lifecycleState = sessionSnapshot?.metadata?.lifecycleState;
                const isActive = daemonTrackedSessionIds.has(sessionId)
                    || !!(sessionSnapshot && sessionSnapshot.active !== false && lifecycleState !== 'archived');

                if (!isActive) {
                    return [];
                }

                const roleId = member?.roleId || member?.role || '';
                const roleDef = roleDefinitions[roleId];
                return [{
                    sessionId,
                    role: roleDef?.title || roleId || 'unknown',
                    roleId,
                    displayName: member?.displayName || sessionId?.substring(0, 8),
                    specId: member?.specId || null,
                    executionPlane: member?.executionPlane ||
                        (BYPASS_ROLE_IDS.includes(roleId) ? 'bypass' : 'mainline'),
                    runtimeType: member?.runtimeType || sessionSnapshot?.metadata?.flavor || 'claude',
                    lifecycleState: lifecycleState || 'running',
                }];
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
            runtimeType: z.enum(['claude', 'codex']).optional().describe('Optional runtime switch. When set, use replace_agent semantics to hot-swap the session onto the requested runtime.'),
        },
    }, async (args) => {
        const metadata = client.getMetadata();
        const role = metadata?.role;
        if (role !== 'supervisor' && role !== 'master' && role !== 'help-agent') {
            return {
                content: [{ type: 'text', text: `Error: Role '${role}' cannot update agent models. Only supervisor/master/help-agent can use this tool.` }],
                isError: true,
            };
        }
        try {
            const session = await api.getSession(args.sessionId);
            if (!session) {
                return { content: [{ type: 'text', text: `Error: Session ${args.sessionId} not found.` }], isError: true };
            }
            const currentRuntime = session.metadata?.flavor === 'codex' ? 'codex' : 'claude';
            if (args.runtimeType && args.runtimeType !== currentRuntime) {
                return {
                    content: [{
                        type: 'text',
                        text: `Runtime switch requested for ${args.sessionId}. Use replace_agent to hot-swap from ${currentRuntime} to ${args.runtimeType}.`
                    }],
                    isError: false,
                };
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

    mcp.registerTool('evaluate_replacement_votes', {
        description: 'Evaluate team vote messages for replacing an agent. Counts the latest keep/replace/unsure vote from each voter for a target session and returns whether replacement quorum has been reached.',
        title: 'Evaluate Replacement Votes',
        inputSchema: {
            targetSessionId: z.string().describe('Session ID being voted on'),
            teamId: z.string().optional().describe('Team ID. Defaults to your current team.'),
            minVotes: z.number().int().min(1).default(2).describe('Minimum number of votes required before replacement can be recommended'),
            limit: z.number().int().min(1).max(500).default(200).describe('How many recent team messages to inspect'),
        },
    }, async (args) => {
        const metadata = client.getMetadata();
        const role = metadata?.role;
        const teamId = args.teamId || metadata?.teamId || metadata?.roomId;

        if (role !== 'supervisor' && role !== 'master' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: `Error: Role '${role}' cannot evaluate replacement votes.` }], isError: true };
        }
        if (!teamId) {
            return { content: [{ type: 'text', text: 'Error: You must be in a team or provide teamId.' }], isError: true };
        }

        try {
            const evaluation = await evaluateReplacementVotes({
                teamId,
                targetSessionId: args.targetSessionId,
                minVotes: args.minVotes,
                limit: args.limit,
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        teamId,
                        targetSessionId: args.targetSessionId,
                        minVotes: args.minVotes,
                        counts: evaluation.counts,
                        totalVotes: evaluation.totalVotes,
                        quorumReached: evaluation.quorumReached,
                        recommendation: evaluation.recommendation,
                        voters: evaluation.votes.map((vote) => ({
                            fromSessionId: vote.fromSessionId,
                            decision: vote.decision,
                            timestamp: vote.timestamp,
                        })),
                    }, null, 2),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error evaluating votes: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('replace_agent', {
        description: 'Hot-swap an agent session after a vote or coordinator decision. Spawns a replacement agent, optionally switches runtime between Claude and Codex, reassigns unfinished tasks, and archives the old session.',
        title: 'Replace Agent',
        inputSchema: {
            sessionId: z.string().describe('Target session ID to replace'),
            teamId: z.string().optional().describe('Team ID. Defaults to your current team or the target session team'),
            runtimeType: z.enum(['claude', 'codex']).optional().describe('Replacement runtime. Defaults to the current runtime.'),
            sessionName: z.string().optional().describe('Optional replacement display name'),
            specId: z.string().optional().describe('Optional explicit genome specId for the replacement'),
            modelId: z.string().optional().describe('Optional model override for the replacement session'),
            fallbackModelId: z.string().optional().describe('Optional fallback model override for the replacement session'),
            reason: z.string().describe('Why the replacement is being performed'),
            minVotes: z.number().int().min(1).default(2).describe('Minimum replace votes required when checkVotes is enabled'),
            checkVotes: z.boolean().default(false).describe('When true, require replace quorum from recent vote messages before proceeding'),
            preserveTasks: z.boolean().default(true).describe('Reassign unfinished tasks from the old session to the new one'),
            archiveOld: z.boolean().default(true).describe('Stop/archive the old session and remove it from the roster after replacement'),
        },
    }, async (args) => {
        const metadata = client.getMetadata();
        const callerRole = metadata?.role;
        if (callerRole !== 'supervisor' && callerRole !== 'master' && callerRole !== 'help-agent') {
            return { content: [{ type: 'text', text: `Error: Role '${callerRole}' cannot replace agents.` }], isError: true };
        }
        if (args.sessionId === client.sessionId) {
            return { content: [{ type: 'text', text: 'Error: Replacing the currently running session from itself is not supported. Use another coordinator/help agent to execute the swap.' }], isError: true };
        }

        try {
            const targetSession = await api.getSession(args.sessionId);
            if (!targetSession) {
                return { content: [{ type: 'text', text: `Error: Session ${args.sessionId} not found.` }], isError: true };
            }

            const inferredTeamId = args.teamId || metadata?.teamId || metadata?.roomId || targetSession.metadata?.teamId || targetSession.metadata?.roomId;
            if (!inferredTeamId) {
                return { content: [{ type: 'text', text: 'Error: Could not determine team for replacement.' }], isError: true };
            }

            const member = await getTeamMemberRecord(inferredTeamId, args.sessionId);
            const roleId = member?.roleId || targetSession.metadata?.role || 'member';
            const currentRuntime = member?.runtimeType === 'codex' || targetSession.metadata?.flavor === 'codex' ? 'codex' : 'claude';
            const nextRuntime = args.runtimeType || currentRuntime;

            if (args.checkVotes) {
                const evaluation = await evaluateReplacementVotes({
                    teamId: inferredTeamId,
                    targetSessionId: args.sessionId,
                    minVotes: args.minVotes,
                });
                if (!evaluation.quorumReached) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Replacement vote quorum not reached for ${args.sessionId}. counts=${JSON.stringify(evaluation.counts)} totalVotes=${evaluation.totalVotes}`,
                        }],
                        isError: true,
                    };
                }
            }

            const replacement = await spawnReplacementSession({
                teamId: inferredTeamId,
                targetSessionId: args.sessionId,
                roleId,
                displayName: args.sessionName || member?.displayName || targetSession.metadata?.name || `${roleId}-replacement`,
                directory: targetSession.metadata?.path || process.cwd(),
                runtimeType: nextRuntime,
                executionPlane: (member?.executionPlane || targetSession.metadata?.executionPlane || 'mainline') as 'mainline' | 'bypass',
                memberId: member?.memberId || targetSession.metadata?.memberId,
                specId: args.specId || (nextRuntime === currentRuntime ? member?.specId : undefined),
                parentSessionId: args.sessionId,
                modelId: args.modelId,
                fallbackModelId: args.fallbackModelId,
            });

            let reassignedTasks = 0;
            if (args.preserveTasks) {
                const tasksResult = await api.listTasks(inferredTeamId, { assigneeId: args.sessionId });
                const tasks = Array.isArray(tasksResult?.tasks) ? tasksResult.tasks : [];
                for (const task of tasks) {
                    if (task?.status === 'done') continue;
                    await api.updateTask(inferredTeamId, task.id, {
                        assigneeId: replacement.sessionId,
                        comment: `Reassigned from ${args.sessionId} to ${replacement.sessionId}. Reason: ${args.reason}`,
                    });
                    reassignedTasks += 1;
                }
            }

            let archivedOld = false;
            if (args.archiveOld) {
                try {
                    const { daemonPost } = await import('@/daemon/controlClient');
                    await daemonPost('/stop-session', { sessionId: args.sessionId });
                } catch (error) {
                    logger.debug(`[replace_agent] stop-session failed for ${args.sessionId}: ${String(error)}`);
                }

                try {
                    await api.batchArchiveSessions([args.sessionId]);
                    archivedOld = true;
                } catch (error) {
                    logger.debug(`[replace_agent] batchArchiveSessions failed for ${args.sessionId}: ${String(error)}`);
                }

                try {
                    await api.removeTeamMember(inferredTeamId, args.sessionId);
                } catch (error) {
                    logger.debug(`[replace_agent] removeTeamMember failed for ${args.sessionId}: ${String(error)}`);
                }
            }

            try {
                await api.sendTeamMessage(inferredTeamId, {
                    id: randomUUID(),
                    teamId: inferredTeamId,
                    type: 'notification',
                    content: `♻️ Replaced ${args.sessionId} with ${replacement.sessionId} (${roleId}, ${currentRuntime} → ${nextRuntime}). Reason: ${args.reason}`,
                    shortContent: `♻️ Replaced ${roleId}: ${currentRuntime}→${nextRuntime}`,
                    timestamp: Date.now(),
                    fromSessionId: client.sessionId,
                    fromRole: callerRole,
                    metadata: {
                        targetSessionId: args.sessionId,
                        replacementSessionId: replacement.sessionId,
                        runtimeType: nextRuntime,
                    },
                });
            } catch (error) {
                logger.debug('[replace_agent] Failed to send replacement notification', error);
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        teamId: inferredTeamId,
                        oldSessionId: args.sessionId,
                        newSessionId: replacement.sessionId,
                        roleId,
                        oldRuntime: currentRuntime,
                        newRuntime: nextRuntime,
                        specId: replacement.specId,
                        specSource: replacement.specSource,
                        reassignedTasks,
                        archivedOld,
                    }, null, 2),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error replacing agent: ${String(error)}` }], isError: true };
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
        if (!/^[a-zA-Z0-9_-]+$/.test(args.teamId)) {
            return { content: [{ type: 'text', text: 'Error: Invalid teamId format.' }], isError: true };
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
            const report = getContextStatusReport({
                homeDir: process.env.HOME || '/tmp',
                metadata: client.getMetadata(),
                ahaSessionId: client.sessionId,
                requestedSessionId: args.sessionId,
            });
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(report, null, 2)
                }],
                isError: false
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('read_cc_log', {
        description: 'Read Claude Code session log (the iron proof). Accepts either a claudeLocalSessionId or an Aha sessionId; when an Aha sessionId is passed, the tool will try to auto-resolve it through daemon team-session metadata. Shows actual tool calls since last supervisor run (cursor-based). Supervisor/help-agent only.',
        title: 'Read CC Log',
        inputSchema: {
            sessionId: z.string().describe('Claude local session ID or Aha session ID to read CC log for. Prefer the claudeLocalSessionId from list_team_runtime_logs/list_team_cc_logs.'),
            limit: z.number().default(100).describe('Max log entries to return'),
            fromByteOffset: z.number().default(-1).describe('Byte offset to read from. -1 = use env AHA_SUPERVISOR_CC_LOG_CURSORS for this claudeLocalSessionId. 0 = read all.'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can read CC logs.' }], isError: true };
        }
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            let resolvedSessionId = args.sessionId;
            let requestedSessionId = args.sessionId;
            let autoResolvedFromAhaSessionId = false;

            if (teamId) {
                try {
                    const { daemonPost } = await import('@/daemon/controlClient');
                    const result = await daemonPost('/list-team-sessions', { teamId });
                    const sessions = Array.isArray(result?.sessions) ? result.sessions as Array<{
                        ahaSessionId: string;
                        claudeLocalSessionId?: string;
                        role?: string;
                        pid: number;
                    }> : [];
                    const match = sessions.find((session) =>
                        session.ahaSessionId === requestedSessionId || session.claudeLocalSessionId === requestedSessionId
                    );
                    if (match?.claudeLocalSessionId && match.ahaSessionId === requestedSessionId) {
                        resolvedSessionId = match.claudeLocalSessionId;
                        autoResolvedFromAhaSessionId = true;
                    }
                } catch (error) {
                    logger.debug('[read_cc_log] Failed to auto-resolve Aha session id via daemon metadata (non-fatal)', error);
                }
            }

            const result = readRuntimeLog({
                homeDir: process.env.HOME || '/tmp',
                runtimeType: 'claude',
                sessionId: resolvedSessionId,
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
                        requestedSessionId,
                        sessionId: resolvedSessionId,
                        autoResolvedFromAhaSessionId,
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

        // ── Trace: score_started ────────────────────────────────────
        let scoreStartedEventId: string | null = null;
        try {
            scoreStartedEventId = emitTraceEvent(
                TraceEventKind.score_started,
                'mcp',
                {
                    team_id: args.teamId,
                    session_id: args.sessionId,
                },
                `Supervisor scoring ${args.role} session=${args.sessionId} action=${args.action}`,
                { attrs: { role: args.role, action: args.action } },
            );
        } catch { /* trace must never break main flow */ }

        // Auto-resolve specId from team member record if not explicitly provided
        let resolvedSpecId = args.specId;
        if (!resolvedSpecId && args.teamId && args.sessionId) {
            try {
                const artifact = await api.getArtifact(args.teamId);
                let board: any = null;
                if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
                    const bodyValue = (artifact.body as { body?: unknown }).body;
                    if (typeof bodyValue === 'string') {
                        try { board = JSON.parse(bodyValue); } catch { /* ignore */ }
                    } else if (bodyValue && typeof bodyValue === 'object') {
                        board = bodyValue;
                    }
                } else {
                    board = artifact.body;
                }
                const members = (board?.team?.members ?? []) as Array<{ sessionId?: string; specId?: string }>;
                const member = members.find(m => m.sessionId === args.sessionId);
                if (member?.specId) {
                    resolvedSpecId = member.specId;
                    logger.debug(`[score_agent] Auto-resolved specId=${resolvedSpecId} from team member record for session ${args.sessionId}`);
                }
            } catch {
                // team lookup failed — proceed without specId
            }
        }

        // Try to resolve specId namespace/name from genome-hub for cleaner grouping
        let specNamespace: string | undefined;
        let specName: string | undefined;
        if (resolvedSpecId) {
            try {
                const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
                const res = await fetch(`${hubUrl}/genomes/id/${encodeURIComponent(resolvedSpecId)}`, { signal: AbortSignal.timeout(3_000) });
                if (res.ok) {
                    const data = await res.json() as { genome?: { namespace?: string; name?: string } };
                    specNamespace = data.genome?.namespace ?? undefined;
                    specName = data.genome?.name ?? undefined;
                }
            } catch { /* proceed without */ }
        }

        // ── Auto-extract tokensUsed from CC log when not provided ─────
        if (args.hardMetrics && args.hardMetrics.tokensUsed === 0) {
            try {
                const { extractTokenUsageFromCcLog } = await import('@/claude/utils/ccLogTokenExtractor');
                const tokenSummary = extractTokenUsageFromCcLog(args.sessionId, process.env.HOME ?? undefined);
                if (tokenSummary && tokenSummary.totalTokens > 0) {
                    args.hardMetrics.tokensUsed = tokenSummary.totalTokens;
                    logger.debug(`[score_agent] Auto-extracted tokensUsed=${tokenSummary.totalTokens} from CC log for session ${args.sessionId}`);
                }
            } catch {
                // Auto-extraction is best-effort; proceed with 0
            }
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

        const feedbackTarget = resolveFeedbackUploadTarget({
            role: args.role,
            specId: resolvedSpecId,
            specNamespace,
            specName,
        });

        writeScore({
            sessionId: args.sessionId,
            teamId: args.teamId,
            role: args.role,
            specId: resolvedSpecId,
            specNamespace: specNamespace ?? feedbackTarget?.namespace,
            specName: specName ?? feedbackTarget?.name,
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

        // ── Trace: score_completed ──────────────────────────────────
        let scoreCompletedEventId: string | null = null;
        try {
            scoreCompletedEventId = emitTraceEvent(
                TraceEventKind.score_completed,
                'mcp',
                {
                    team_id: args.teamId,
                    session_id: args.sessionId,
                },
                `Scored ${args.role} session=${args.sessionId}: overall=${overall} action=${args.action}`,
                { attrs: { overall, action: args.action, scoringMode } },
            );
            if (scoreCompletedEventId && scoreStartedEventId) {
                emitTraceLink(scoreCompletedEventId, scoreStartedEventId, 'caused_by');
            }
        } catch { /* trace must never break main flow */ }

        // ── Phase 3-B Change 3: Auto-trigger feedback upload when >= 3 scores ──
        if (feedbackTarget) {
            try {
                const { readScores } = await import('@/claude/utils/scoreStorage');
                const { scores: allScores } = readScores();
                const genomeScores = allScores.filter((score) =>
                    scoreMatchesFeedbackTarget(score, feedbackTarget, args.role)
                );
                if (genomeScores.length >= 3) {
                    const { aggregateScores } = await import('@/claude/utils/feedbackPrivacy');
                    const feedback = aggregateScores(genomeScores);
                    const upload = await syncGenomeFeedbackToMarketplace({
                        target: feedbackTarget,
                        role: args.role,
                        feedback: feedback!,
                        hubUrl: process.env.GENOME_HUB_URL ?? 'http://localhost:3006',
                        hubPublishKey: process.env.HUB_PUBLISH_KEY ?? '',
                    });

                    if (!upload.ok) {
                        logger.debug(
                            `[score_agent] Auto-feedback upload failed for ${feedbackTarget.namespace}/${feedbackTarget.name}: ${upload.status} ${upload.body}`,
                        );
                    } else {
                        logger.debug(
                            `[score_agent] Auto-triggered feedback upload for ${feedbackTarget.namespace}/${feedbackTarget.name} (${genomeScores.length} scores, source=${feedbackTarget.source}, createdGenome=${upload.createdGenome})`,
                        );

                        // ── Trace: feedback_uploaded ────────────────────────
                        try {
                            const feedbackEventId = emitTraceEvent(
                                TraceEventKind.feedback_uploaded,
                                'mcp',
                                {
                                    team_id: args.teamId,
                                    session_id: args.sessionId,
                                },
                                `Feedback uploaded for ${feedbackTarget.namespace}/${feedbackTarget.name} (${genomeScores.length} scores, createdGenome=${upload.createdGenome})`,
                                { attrs: { namespace: feedbackTarget.namespace, name: feedbackTarget.name, scoreCount: genomeScores.length } },
                            );
                            if (feedbackEventId && scoreCompletedEventId) {
                                emitTraceLink(feedbackEventId, scoreCompletedEventId, 'caused_by');
                            }
                        } catch { /* trace must never break main flow */ }
                    }
                }
            } catch (error) {
                logger.debug(`[score_agent] Auto-feedback upload error for role ${args.role}: ${String(error)}`);
            }
        }

        // ── Immune system: score < 60 → auto-trigger help-agent to replace underperformer ──
        // When a supervisor scores an agent below 60, it means the agent is failing.
        // Rather than silently continuing, we auto-request a help-agent to kill and replace it.
        if (overall < 60) {
            try {
                const immuneTeamId = args.teamId;
                const failureContext = [
                    `Agent role=${args.role} scored ${overall}/100 (below 60 threshold).`,
                    args.recommendations?.length
                        ? `Failure reasons: ${args.recommendations.join('; ')}`
                        : '',
                    resolvedSpecId ? `Genome specId=${resolvedSpecId}.` : '',
                    `Call replace_agent(sessionId="${args.sessionId}", reason=...) to swap with a better-matched genome.`,
                ].filter(Boolean).join(' ');

                const { helpSpawned } = await triggerHelpLane({
                    teamId: immuneTeamId,
                    sessionId: args.sessionId,
                    role: 'supervisor',
                    type: 'error',
                    description: `[AUTO-IMMUNE] ${failureContext}`,
                    severity: 'high',
                    sendNotification: true,
                });

                logger.debug(
                    `[score_agent] Immune system: overall=${overall} < 60 for ${args.role}/${args.sessionId}, helpSpawned=${helpSpawned}`,
                );
            } catch (error) {
                logger.debug(`[score_agent] Immune system error: ${String(error)}`);
            }
        }

        const dimSummary = `delivery=${dimensions.delivery} integrity=${dimensions.integrity} efficiency=${dimensions.efficiency} collaboration=${dimensions.collaboration} reliability=${dimensions.reliability}`;
        const hardInfo = hardMetricsScore !== undefined ? ` hardMetricsScore=${hardMetricsScore}` : '';
        const sessionInfo = ` sessionScore(task_completion=${sessionScore.taskCompletion}, code_quality=${sessionScore.codeQuality}, collaboration=${sessionScore.collaboration}, overall=${sessionScore.overall})`;
        const autoResolvedNote = !args.specId && resolvedSpecId ? ' (specId auto-resolved from team member)' : '';
        return {
            content: [{
                type: 'text',
                text: `Scored ${args.role}${resolvedSpecId ? ` (specId=${resolvedSpecId}${autoResolvedNote})` : ''} session=${args.sessionId}: overall=${overall},${hardInfo}${sessionInfo} action=${args.action}, mode=${scoringMode}\n${dimSummary}`,
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
            genomeNamespace: z.string().optional().describe("Genome namespace, e.g. '@official'. Optional when genomeId is provided."),
            genomeName: z.string().optional().describe("Genome name, e.g. 'implementer'. Optional when genomeId is provided."),
            genomeId: z.string().optional().describe('Genome ID (preferred over namespace+name). When provided, the tool auto-resolves namespace/name from genome-hub and falls back to the canonical role genome if needed.'),
            role: z.string().describe('Role name used as fallback filter when specId not recorded on older scores'),
            dryRun: z.boolean().optional().describe('If true, show what would be sent without uploading'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (callerRole !== 'supervisor') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor can update genome feedback.' }], isError: true };
        }

        let resolvedNamespace = args.genomeNamespace;
        let resolvedName = args.genomeName;

        if ((!resolvedNamespace || !resolvedName) && args.genomeId) {
            try {
                const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
                const res = await fetch(`${hubUrl}/genomes/id/${encodeURIComponent(args.genomeId)}`, {
                    signal: AbortSignal.timeout(5_000),
                });
                if (res.ok) {
                    const data = await res.json() as { genome?: { namespace?: string; name?: string } };
                    resolvedNamespace = resolvedNamespace ?? data.genome?.namespace;
                    resolvedName = resolvedName ?? data.genome?.name;
                }
            } catch {
                // Fall through to canonical role fallback below.
            }
        }

        const feedbackTarget = resolveFeedbackUploadTarget({
            role: args.role,
            specId: args.genomeId,
            specNamespace: resolvedNamespace,
            specName: resolvedName,
        });
        if (!feedbackTarget) {
            return {
                content: [{
                    type: 'text',
                    text: `Could not resolve a marketplace feedback target for role '${args.role}'. Provide genomeId or explicit genomeNamespace/genomeName, or use a canonical official role.`,
                }],
                isError: true,
            };
        }

        resolvedNamespace = feedbackTarget.namespace;
        resolvedName = feedbackTarget.name;

        // Read local scores — prefer resolved genome identity, fall back to canonical role matching
        const { readScores } = await import('@/claude/utils/scoreStorage');
        const { scores } = readScores();
        const roleScores = scores.filter((score) =>
            scoreMatchesFeedbackTarget(score, feedbackTarget, args.role)
        );

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
            return {
                content: [{
                    type: 'text',
                    text: `DRY RUN — would send to ${resolvedNamespace}/${resolvedName}:\n${summary}\n\nPrivacy: session IDs, team IDs, file paths, and raw evidence are stripped before upload.`,
                }],
                isError: false,
            };
        }

        try {
            const upload = await syncGenomeFeedbackToMarketplace({
                target: feedbackTarget,
                role: args.role,
                feedback,
                hubUrl: process.env.GENOME_HUB_URL ?? 'http://localhost:3006',
                hubPublishKey: process.env.HUB_PUBLISH_KEY ?? '',
            });

            if (!upload.ok) {
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to update genome hub for ${resolvedNamespace}/${resolvedName}: ${upload.status} ${upload.body}`,
                    }],
                    isError: true,
                };
            }

            return {
                content: [{
                    type: 'text',
                    text: `Feedback uploaded to marketplace (${resolvedNamespace}/${resolvedName}${upload.createdGenome ? ', created placeholder genome' : ''}):\n${summary}`,
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error: ${String(error)}` }], isError: true };
        }
    });

    // ── Evolution Materializer: evolve_genome ───────────────────────────────
    mcp.registerTool('evolve_genome', {
        description: [
            'Promote a genome to the next version by merging supervisor-synthesized learnings into spec.memory.learnings.',
            'Step 1: Read feedbackData via update_genome_feedback (dryRun=true) to review suggestions.',
            'Step 2: Synthesize 3-7 actionable learnings from the feedback patterns.',
            'Step 3: Call evolve_genome with the synthesized learnings — it merges them into the spec and calls promote.',
            'Requires feedbackData.avgScore >= minPromoteScore (default 60). Supervisor only.',
        ].join(' '),
        title: 'Evolve Genome',
        inputSchema: {
            genomeNamespace: z.string().describe("Genome namespace, e.g. '@official'."),
            genomeName: z.string().describe("Genome name, e.g. 'implementer'."),
            newLearnings: z.array(z.string().max(300)).min(1).max(10).describe(
                'Synthesized learnings derived from feedbackData patterns. Each item is a short, actionable insight for future instances of this genome.'
            ),
            minPromoteScore: z.number().min(0).max(100).default(60).optional().describe(
                'Minimum avgScore required to promote. Defaults to 60.'
            ),
            dryRun: z.boolean().optional().describe('If true, show the merged spec without calling promote.'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (callerRole !== 'supervisor') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor can evolve genomes.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
        const publishKey = process.env.HUB_PUBLISH_KEY ?? '';

        // 1. Fetch current genome (spec + feedbackData)
        let genomeRecord: { genome?: { spec: string; feedbackData?: string | null } };
        try {
            const res = await fetch(
                `${hubUrl}/genomes/${encodeURIComponent(args.genomeNamespace)}/${encodeURIComponent(args.genomeName)}`,
                { signal: AbortSignal.timeout(5_000) }
            );
            if (!res.ok) {
                return { content: [{ type: 'text', text: `Genome ${args.genomeNamespace}/${args.genomeName} not found: ${res.status}` }], isError: true };
            }
            genomeRecord = await res.json() as { genome?: { spec: string; feedbackData?: string | null } };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error fetching genome: ${String(error)}` }], isError: true };
        }

        if (!genomeRecord.genome) {
            return { content: [{ type: 'text', text: 'Unexpected response from genome-hub.' }], isError: true };
        }

        // 2. Validate feedbackData score threshold
        let currentSpec: Record<string, unknown>;
        try {
            currentSpec = JSON.parse(genomeRecord.genome.spec) as Record<string, unknown>;
        } catch {
            return { content: [{ type: 'text', text: 'Failed to parse current genome spec JSON.' }], isError: true };
        }

        let avgScore = 0;
        const feedbackRaw = genomeRecord.genome.feedbackData;
        if (feedbackRaw) {
            try {
                const fb = JSON.parse(feedbackRaw) as { avgScore?: number };
                avgScore = typeof fb.avgScore === 'number' ? fb.avgScore : 0;
            } catch { /* proceed with 0 */ }
        }

        const minScore = args.minPromoteScore ?? 60;
        if (avgScore < minScore) {
            return {
                content: [{ type: 'text', text: `Cannot evolve: avgScore=${Math.round(avgScore)} < minPromoteScore=${minScore}. Accumulate more evaluations via score_agent + update_genome_feedback first.` }],
                isError: true,
            };
        }

        // 3. Merge new learnings into spec.memory.learnings (deduplicated)
        const existingMemory = (currentSpec.memory ?? {}) as Record<string, unknown>;
        const existingLearnings: string[] = Array.isArray(existingMemory.learnings) ? existingMemory.learnings as string[] : [];
        const mergedLearnings = Array.from(new Set([...existingLearnings, ...args.newLearnings]));
        const evolvedSpec = {
            ...currentSpec,
            memory: {
                ...existingMemory,
                learnings: mergedLearnings,
            },
        };

        if (args.dryRun) {
            return {
                content: [{
                    type: 'text',
                    text: [
                        `DRY RUN — evolve ${args.genomeNamespace}/${args.genomeName}`,
                        `Current avgScore: ${Math.round(avgScore)} (threshold: ${minScore}) ✅`,
                        `Existing learnings: ${existingLearnings.length}`,
                        `New learnings to merge: ${args.newLearnings.length}`,
                        `Merged total: ${mergedLearnings.length}`,
                        `New entries: ${args.newLearnings.filter(l => !existingLearnings.includes(l)).join(' | ')}`,
                    ].join('\n'),
                }],
                isError: false,
            };
        }

        // 4. Call promote endpoint
        try {
            const promoteRes = await fetch(
                `${hubUrl}/genomes/${encodeURIComponent(args.genomeNamespace)}/${encodeURIComponent(args.genomeName)}/promote`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(publishKey ? { Authorization: `Bearer ${publishKey}` } : {}),
                    },
                    body: JSON.stringify({
                        spec: JSON.stringify(evolvedSpec),
                        minAvgScore: minScore,
                        isPublic: true,
                    }),
                    signal: AbortSignal.timeout(10_000),
                }
            );

            if (!promoteRes.ok) {
                const errBody = await promoteRes.text();
                return { content: [{ type: 'text', text: `Promote failed: ${promoteRes.status} ${errBody}` }], isError: true };
            }

            const promoted = await promoteRes.json() as { genome?: { version?: number; id?: string } };
            const newVersion = promoted.genome?.version ?? '?';
            const addedCount = args.newLearnings.filter(l => !existingLearnings.includes(l)).length;

            return {
                content: [{
                    type: 'text',
                    text: `✅ Evolved ${args.genomeNamespace}/${args.genomeName} → v${newVersion}. Added ${addedCount} new learnings (total: ${mergedLearnings.length}).`,
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error during promote: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('update_team_feedback', {
        description: [
            'Submit a public review for the current team and persist a real team scorecard on the server.',
            'Use this after a supervisor cycle when you have enough evidence to judge overall collaboration quality.',
            'Supervisor only.',
        ].join(' '),
        title: 'Update Team Feedback',
        inputSchema: {
            teamId: z.string().describe('Team id to review'),
            rating: z.number().min(1).max(5).describe('Overall team rating on a 1-5 scale'),
            codeScore: z.number().min(0).max(100).optional().describe('Optional code execution score'),
            qualityScore: z.number().min(0).max(100).optional().describe('Optional quality/collaboration score'),
            source: z.enum(['user', 'master', 'system']).default('system').optional().describe('Review source bucket'),
            sourceScores: z.object({
                user: z.number().optional(),
                master: z.number().optional(),
                system: z.number().optional(),
            }).optional().describe('Optional explicit source totals to add to the scorecard'),
            roleIds: z.array(z.string()).optional().describe('Roles included in this team review'),
            comment: z.string().optional().describe('Short public review note'),
            dryRun: z.boolean().optional().describe('If true, do not persist; return the payload only'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (callerRole !== 'supervisor') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor can update team feedback.' }], isError: true };
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(args.teamId)) {
            return { content: [{ type: 'text', text: 'Error: Invalid teamId format.' }], isError: true };
        }

        const payload = {
            rating: args.rating,
            ...(args.codeScore !== undefined ? { codeScore: args.codeScore } : {}),
            ...(args.qualityScore !== undefined ? { qualityScore: args.qualityScore } : {}),
            ...(args.source ? { source: args.source } : {}),
            ...(args.sourceScores ? { sourceScores: args.sourceScores } : {}),
            ...(args.roleIds ? { roleIds: args.roleIds } : {}),
            ...(args.comment ? { comment: args.comment } : {}),
        };

        if (args.dryRun) {
            return {
                content: [{ type: 'text', text: `DRY RUN — would submit team review:\n${JSON.stringify({ teamId: args.teamId, ...payload }, null, 2)}` }],
                isError: false,
            };
        }

        try {
            const response = await api.reviewTeam(args.teamId, payload);
            return {
                content: [{
                    type: 'text',
                    text: `Team feedback uploaded: rating=${response.scorecard.averageRating?.toFixed ? response.scorecard.averageRating.toFixed(2) : response.scorecard.averageRating} reviews=${response.scorecard.reviewCount} codeTotal=${response.scorecard.cumulativeCode} qualityTotal=${response.scorecard.cumulativeQuality}`,
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error updating team feedback: ${String(error)}` }], isError: true };
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
            const session = await api.getSession(args.sessionId);
            if (!session || session.active === false || session.metadata?.lifecycleState === 'archived') {
                return { content: [{ type: 'text', text: `Session ${args.sessionId} is not live. Skipping compact RPC.` }], isError: true };
            }

            const trackedSessionIds = await getDaemonTrackedSessionIds();
            if (!trackedSessionIds.has(args.sessionId)) {
                return { content: [{ type: 'text', text: `Session ${args.sessionId} is not tracked by the local daemon. Skipping compact RPC.` }], isError: true };
            }

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
            const session = await api.getSession(args.sessionId);
            if (!session || session.active === false || session.metadata?.lifecycleState === 'archived') {
                return { content: [{ type: 'text', text: `Session ${args.sessionId} is not live. Skipping kill RPC.` }], isError: true };
            }

            const trackedSessionIds = await getDaemonTrackedSessionIds();
            if (!trackedSessionIds.has(args.sessionId)) {
                return { content: [{ type: 'text', text: `Session ${args.sessionId} is not tracked by the local daemon. Skipping kill RPC.` }], isError: true };
            }

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

    mcp.registerTool('archive_session', {
        description: 'Archive an agent session, removing it from the active team roster. Supervisor/org-manager only. Use when an agent has completed its work or needs to be retired. Use recover_session to restore.',
        title: 'Archive Session',
        inputSchema: {
            sessionId: z.string().describe('Session ID to archive'),
            reason: z.string().describe('Why this session is being archived'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'org-manager' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/org-manager/help-agent can archive sessions.' }], isError: true };
        }
        try {
            const result = await api.batchArchiveSessions([args.sessionId]);
            return {
                content: [{ type: 'text', text: JSON.stringify({ archived: result.archived, reason: args.reason }) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('recover_session', {
        description: 'Restore a previously archived agent session, making it active again in the team roster. Supervisor/org-manager only. Use when an archived agent needs to resume work.',
        title: 'Recover Session',
        inputSchema: {
            sessionId: z.string().describe('Session ID to restore from archive'),
            reason: z.string().describe('Why this session is being restored'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'org-manager' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/org-manager/help-agent can recover sessions.' }], isError: true };
        }
        try {
            const result = await api.batchUnarchiveSessions([args.sessionId]);
            return {
                content: [{ type: 'text', text: JSON.stringify({ restored: result.restored, reason: args.reason }) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    // ========== Runtime-Aware Supervisor Log Tools ==========

    mcp.registerTool('list_team_runtime_logs', {
        description: 'List runtime log files for team agents across Claude and Codex. Returns ahaSessionId, claudeLocalSessionId, and the exact readSessionId/cursorKey to use with read_runtime_log. For Claude, readSessionId is the claudeLocalSessionId (NOT the Aha sessionId). Supervisor/help-agent only.',
        title: 'List Team Runtime Logs',
        inputSchema: {
            teamId: z.string().describe('Team ID to list runtime logs for'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can use this tool.' }], isError: true };
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(args.teamId)) {
            return { content: [{ type: 'text', text: 'Error: Invalid teamId format.' }], isError: true };
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
        description: 'Read runtime-aware supervisor evidence logs with cursor support. Supports Claude session logs, Codex history, and Codex session transcripts. For Claude, sessionId must be the claudeLocalSessionId returned by list_team_runtime_logs (never the Aha sessionId). Supervisor/help-agent only.',
        title: 'Read Runtime Log',
        inputSchema: {
            runtimeType: z.enum(['claude', 'codex', 'open-code']).describe('Runtime to read logs for'),
            sessionId: z.string().optional().describe('Claude: claudeLocalSessionId from list_team_runtime_logs. Codex session logs: transcript session id / aha session id. Required for session logs.'),
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
        description: 'Legacy Claude-only alias for list_team_runtime_logs. Returns ahaSessionId → claudeLocalSessionId + log file path. Prefer list_team_runtime_logs + read_runtime_log; if you use this tool, pass the returned claudeLocalSessionId (not the Aha sessionId) into read_cc_log. Supervisor/help-agent only.',
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
            ccLogCursors: z.record(z.string(), z.number()).describe('Map of claudeLocalSessionId → nextByteOffset from read_runtime_log/read_cc_log results'),
            codexHistoryCursor: z.number().optional().describe('Line cursor into ~/.codex/history.jsonl after the last inspected entry'),
            codexSessionCursors: z.record(z.string(), z.number()).optional().describe('Map of Codex session id → next byte offset in ~/.codex/sessions/... transcript files'),
            conclusion: z.string().describe('2-4 sentence plain-text summary of this supervisor cycle findings'),
            sessionId: z.string().optional().describe('This supervisor session ID (for potential --resume on next run)'),
            teamTerminated: z.boolean().default(false).describe('Set true if the team appears fully done and no further supervision is needed'),
            pendingAction: z.union([
                z.object({
                    type: z.literal('notify_help'),
                    message: z.string().describe('Help/intervention message to carry into the next cycle'),
                    requestType: z.enum(['stuck', 'context_overflow', 'need_collaborator', 'error', 'custom']).optional(),
                    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
                    description: z.string().optional(),
                    targetSessionId: z.string().optional(),
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

            await updateSupervisorState(args.teamId, (state) => {
                const nextPendingAction = args.pendingAction !== undefined ? args.pendingAction : state.pendingAction;
                const nextPendingActionMeta = args.pendingAction === undefined && nextPendingAction
                    ? state.pendingActionMeta
                    : null;

                return {
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
                    pendingAction: nextPendingAction,
                    pendingActionMeta: nextPendingActionMeta,
                    predictions,
                };
            });
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

            // ── Trace: help_requested ───────────────────────────────────
            let helpRequestedEventId: string | null = null;
            try {
                helpRequestedEventId = emitTraceEvent(
                    TraceEventKind.help_requested,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: args.taskId,
                        session_id: sessionId,
                    },
                    `${role || 'unknown'} requested help (${args.type}, severity=${args.severity}): ${args.description.slice(0, 200)}`,
                    { attrs: { helpType: args.type, severity: args.severity } },
                );
            } catch { /* trace must never break main flow */ }

            const { helpSpawned, error } = await triggerHelpLane({
                teamId,
                sessionId,
                role,
                type: args.type,
                description: args.description,
                severity: args.severity,
                taskId: args.taskId,
                sendNotification: true,
            });

            // ── Trace: help_agent_spawned (if spawn confirmed) ──────────
            if (helpSpawned && helpRequestedEventId) {
                try {
                    const spawnedId = emitTraceEvent(
                        TraceEventKind.help_agent_spawned,
                        'mcp',
                        {
                            team_id: teamId,
                            task_id: args.taskId,
                            session_id: sessionId,
                        },
                        `Help-agent spawned for ${role || 'unknown'} (${args.type}, severity=${args.severity})`,
                    );
                    if (spawnedId && helpRequestedEventId) {
                        emitTraceLink(spawnedId, helpRequestedEventId, 'caused_by');
                    }
                } catch { /* trace must never break main flow */ }
            }

            return {
                content: [{
                    type: 'text',
                    text: helpSpawned
                        ? `Help request logged and help-agent spawned (${args.type}, severity: ${args.severity}). A help-agent is joining the team to assist you.`
                        : `Help request logged (${args.type}, severity: ${args.severity}). The supervisor has been notified, but help-agent spawn was not confirmed${error ? `: ${error}` : ''}. If no help-agent appears within a few minutes, try again or ask @master for coordination.`,
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
            parentId: z.string().optional().describe('ID of the parent genome this was forked/mutated from. Set when evolving an existing genome.'),
            mutationNote: z.string().optional().describe('Brief description of what changed from the parent genome.'),
            origin: z.enum(['original', 'forked', 'mutated']).optional().describe('Provenance origin type. Defaults to "original".'),
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

            // ── Spec validation & sanitization ──────────────────────────
            let specStr = args.spec;

            // Size guard: reject oversized specs
            if (specStr.length > 64000) {
                return {
                    content: [{ type: 'text', text: 'Error: spec exceeds 64KB size limit.' }],
                    isError: true,
                };
            }

            let specObj: Record<string, unknown>;
            try {
                specObj = JSON.parse(specStr);
            } catch {
                return {
                    content: [{ type: 'text', text: 'Error: spec is not valid JSON.' }],
                    isError: true,
                };
            }

            // Strip forbidden keys for non-@official namespaces
            const isOfficial = args.namespace === '@official';
            if (!isOfficial) {
                const FORBIDDEN_KEYS = ['hooks', 'permissionMode', 'executionPlane'] as const;
                for (const key of FORBIDDEN_KEYS) {
                    delete specObj[key];
                }
                // Downgrade full-access to default
                if (specObj.accessLevel === 'full-access') {
                    delete specObj.accessLevel;
                }
            }

            // Inject provenance into spec if parentId is provided
            if (args.parentId) {
                specObj.provenance = {
                    ...((specObj.provenance as Record<string, unknown>) || {}),
                    origin: args.origin || 'forked',
                    parentId: args.parentId,
                    mutationNote: args.mutationNote || null,
                };
            }

            specStr = JSON.stringify(specObj);

            const result = await api.createGenome({
                id: args.id,
                name: args.name,
                description: args.description,
                spec: specStr,
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
            'add_task_comment',
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
            'replace_agent',
            'evaluate_replacement_votes',
            'update_agent_model',
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
            'evolve_genome',
            'update_team_feedback',
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
