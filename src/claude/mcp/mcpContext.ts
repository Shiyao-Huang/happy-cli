/**
 * @module mcpContext
 * @description Shared context type and helper closures for Aha MCP tool modules.
 *
 * ```mermaid
 * graph LR
 *   A[mcpContext] -->|McpToolContext| B[contextTools]
 *   A -->|McpToolContext| C[teamTools]
 *   A -->|McpToolContext| D[taskTools]
 *   A -->|McpToolContext| E[agentTools]
 *   A -->|McpToolContext| F[supervisorTools]
 *   A -->|McpToolContext| G[evolutionTools]
 * ```
 *
 * ## Design
 * - McpToolContext is passed into every register* function so all shared
 *   closures (api, client, helpers) remain accessible without re-declaring.
 * - Helper functions (triggerHelpLane, etc.) live here because they are
 *   referenced by more than one tool module.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { TaskStateManager } from '../utils/taskStateManager';
import { readDaemonState } from '@/persistence';
import { createReplacementTeamMemberIdentity, createTeamMemberIdentity } from '../utils/teamMemberIdentity';
import { resolvePreferredGenomeSpecId } from '@/utils/genomeMarketplace';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type VoteDecision = 'keep' | 'replace' | 'unsure';

export interface McpToolContext {
    mcp: McpServer;
    api: any;
    client: ApiSessionClient;
    genomeSpecRef?: { current: import('../../api/types/genome').GenomeSpec | null | undefined };
    handler: (title: string) => Promise<{ success: boolean; error?: string }>;
    pingDaemonHeartbeat: () => Promise<void>;
    getTaskStateManager: () => TaskStateManager | null;
    parseBoardFromArtifact: (artifact: any) => any;
    getCurrentTeamMemberContext: (teamId: string) => Promise<{
        board: any | null;
        member: any | null;
        authorities: string[];
        teamOverlay: any | null;
        effectiveGenome: any;
    }>;
    HELP_MENTION_RE: RegExp;
    toHelpSeverity: (priority?: 'normal' | 'high' | 'urgent') => 'low' | 'medium' | 'high' | 'critical';
    containsHelpMention: (content: string) => boolean;
    listDaemonTrackedSessions: () => Promise<Array<{ ahaSessionId: string; pid: number }>>;
    getDaemonTrackedSessionIds: () => Promise<Set<string>>;
    getTeamMemberRecord: (teamId: string, sessionId: string) => Promise<any | null>;
    parseVoteDecision: (content: string) => VoteDecision | null;
    evaluateReplacementVotes: (params: {
        teamId: string;
        targetSessionId: string;
        limit?: number;
        minVotes?: number;
    }) => Promise<{
        counts: Record<VoteDecision, number>;
        votes: Array<{ fromSessionId: string; decision: VoteDecision; content: string; timestamp: number }>;
        totalVotes: number;
        quorumReached: boolean;
        recommendation: VoteDecision | 'no-decision';
    }>;
    spawnReplacementSession: (params: {
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
    }) => Promise<{ sessionId: string; memberId: string; sessionTag: string; specId: string | null; specSource: string }>;
    triggerHelpLane: (params: {
        teamId: string;
        sessionId: string;
        role?: string;
        type: 'stuck' | 'context_overflow' | 'need_collaborator' | 'error' | 'custom';
        description: string;
        severity: 'low' | 'medium' | 'high' | 'critical';
        taskId?: string;
        sendNotification?: boolean;
    }) => Promise<{ helpSpawned: boolean; error?: string }>;
}

export class ReplaceAgentStageError extends Error {
    readonly stage: string;
    readonly details: Record<string, unknown>;
    readonly remediation?: string;

    constructor(stage: string, message: string, details: Record<string, unknown> = {}, remediation?: string) {
        super(message);
        this.name = 'ReplaceAgentStageError';
        this.stage = stage;
        this.details = details;
        this.remediation = remediation;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory: build all shared helpers from the outer closure variables
// ──────────────────────────────────────────────────────────────────────────────

export function buildMcpHelpers(
    api: any,
    client: ApiSessionClient,
    genomeSpecRef: { current: import('../../api/types/genome').GenomeSpec | null | undefined } | undefined,
): Omit<McpToolContext, 'mcp' | 'handler' | 'pingDaemonHeartbeat'> {

    const getTaskStateManager = (): TaskStateManager | null => {
        const metadata = client.getMetadata();
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
            throw new ReplaceAgentStageError(
                'spawn.replacement.daemon_state',
                'Daemon is not running. Cannot replace agents without a running daemon.',
                { daemonState: daemonState ?? null },
                "Restart the daemon with 'aha daemon start' before retrying replace_agent.",
            );
        }
        try {
            process.kill(daemonState.pid, 0);
        } catch {
            throw new ReplaceAgentStageError(
                'spawn.replacement.daemon_pid',
                `Daemon state file is stale (PID ${daemonState.pid} not found).`,
                { pid: daemonState.pid, httpPort: daemonState.httpPort },
                "Restart the daemon with 'aha daemon start' and retry the replacement.",
            );
        }

        // A replacement must mint a fresh member/session identity; reusing the prior
        // member tag causes getOrCreateSession(tag=...) to return the old session.
        const { memberId, sessionTag } = createReplacementTeamMemberIdentity(params.teamId, params.memberId);
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

        let response: Response;
        try {
            response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/spawn-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(spawnBody),
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            throw new ReplaceAgentStageError(
                'spawn.replacement.fetch',
                error instanceof Error ? error.message : String(error),
                {
                    daemonHttpPort: daemonState.httpPort,
                    teamId: params.teamId,
                    roleId: params.roleId,
                    runtimeType: params.runtimeType,
                },
                'Verify the daemon control server is reachable and accepting spawn-session requests.',
            );
        }

        let result: { success?: boolean; sessionId?: string; error?: string };
        try {
            result = await response.json() as { success?: boolean; sessionId?: string; error?: string };
        } catch (error) {
            throw new ReplaceAgentStageError(
                'spawn.replacement.parse',
                error instanceof Error ? error.message : String(error),
                { httpStatus: response.status },
                'Inspect the daemon response body for malformed JSON or server-side crashes.',
            );
        }
        if (!response.ok || !result.success || !result.sessionId) {
            throw new ReplaceAgentStageError(
                'spawn.replacement.response',
                result.error || `HTTP ${response.status}`,
                { httpStatus: response.status, responseOk: response.ok, responseBody: result },
                'Fix the daemon spawn-session error before retrying replacement.',
            );
        }

        if (result.sessionId === params.targetSessionId) {
            throw new ReplaceAgentStageError(
                'spawn.replacement.identity',
                `Replacement reused the original sessionId (${result.sessionId}) instead of minting a new session.`,
                { targetSessionId: params.targetSessionId, replacementSessionId: result.sessionId, sessionTag, memberId },
                'Ensure replacement sessions use a fresh member/session identity rather than the original session tag.',
            );
        }

        try {
            await api.addTeamMember(
                params.teamId,
                result.sessionId,
                params.roleId,
                params.displayName,
                {
                    memberId,
                    sessionTag,
                    ...(resolvedSpec.specId ? { candidateId: `spec:${resolvedSpec.specId}` } : {}),
                    specId: resolvedSpec.specId ?? undefined,
                    parentSessionId: params.parentSessionId || params.targetSessionId,
                    executionPlane: params.executionPlane,
                    runtimeType: params.runtimeType,
                }
            );
        } catch (error) {
            throw new ReplaceAgentStageError(
                'spawn.replacement.register_member',
                error instanceof Error ? error.message : String(error),
                { replacementSessionId: result.sessionId, teamId: params.teamId, memberId, sessionTag },
                'Check team member registration and server-side team membership APIs.',
            );
        }

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

        // Deduplication: one live help-agent per team. Reuse it instead of spawning duplicates.
        try {
            const activeSessions = await listTeamSessionsViaDaemon(teamId);
            const activeHelpAgents = activeSessions.filter((s) => s.role === 'help-agent');
            if (activeHelpAgents.length > 0) {
                const reusableSessionId = activeHelpAgents[0].ahaSessionId || 'unknown';
                logger.debug(`[help-lane] Reusing existing help-agent ${reusableSessionId} for team ${teamId}; skipping duplicate spawn`);
                return { helpSpawned: true };
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

    return {
        api,
        client,
        genomeSpecRef,
        getTaskStateManager,
        parseBoardFromArtifact,
        getCurrentTeamMemberContext,
        HELP_MENTION_RE,
        toHelpSeverity,
        containsHelpMention,
        listDaemonTrackedSessions,
        getDaemonTrackedSessionIds,
        parseVoteDecision,
        getTeamMemberRecord,
        evaluateReplacementVotes,
        spawnReplacementSession,
        triggerHelpLane,
    };
}
