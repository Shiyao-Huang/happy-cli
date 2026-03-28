import { DEFAULT_GENOME_HUB_URL, readPublishKeyFromSettings } from '@/configurationResolver'
import type { RunEnvelope } from '@/daemon/runEnvelope'
/**
 * @module supervisorTools
 * @description MCP tool registrations for supervisor-only monitoring, scoring, and evolution.
 *
 * ```mermaid
 * graph LR
 *   A[supervisorTools] -->|ctx.mcp| B[McpServer]
 *   A -->|ctx.api| C[ApiClient]
 *   A -->|ctx.client| D[ApiSessionClient]
 *   A -->|ctx.genomeSpecRef| E[GenomeSpec]
 *   A -->|ctx.triggerHelpLane| F[helpLane]
 *   A -->|ctx.getDaemonTrackedSessionIds| G[daemonTracker]
 * ```
 *
 * ## Tools registered
 * - read_team_log, get_context_status, get_self_view, read_cc_log,
 *   score_agent, update_genome_feedback, evolve_genome, update_team_feedback,
 *   kill_agent, archive_session, recover_session,
 *   list_team_runtime_logs, read_runtime_log, list_team_cc_logs,
 *   save_supervisor_state, score_supervisor_self,
 *   tsc_check, restart_daemon, git_diff_summary,
 *   get_effective_permissions
 *
 * ## Design
 * - All tools share McpToolContext (see mcpContext.ts)
 * - Most tools are restricted to role=supervisor or supervisor/help-agent
 * - score_agent triggers the immune system via ctx.triggerHelpLane when overall < 60
 * - Dynamic imports used for heavy modules (feedbackPrivacy, sessionScoring, supervisorState)
 */

import { z } from "zod";
import { logger } from "@/ui/logger";
import { configuration } from '@/configuration';
import { writeScore, readScores } from '@/claude/utils/scoreStorage';
import { aggregateScores } from '@/claude/utils/feedbackPrivacy';
import { resolveFeedbackUploadTarget, scoreMatchesFeedbackTarget } from '../utils/supervisorGenomeFeedback';
import { syncGenomeFeedbackToMarketplace } from '../utils/genomeFeedbackSync';
import { projectSelfMirrorIdentity } from '../utils/runEnvelopeMirror';
import { readRuntimeLog, resolveTeamRuntimeLogs } from '../utils/runtimeLogReader';
import { getContextStatusReport } from '../utils/contextStatus';
import { fetchGenomeSpec } from '../utils/fetchGenome';
import { emitTraceEvent, emitTraceLink } from '@/trace/traceEmitter';
import { TraceEventKind } from '@/trace/traceTypes';
import { readDaemonState } from '@/persistence';
import { restartDaemonFlow } from '@/daemon/restartDaemon';
import { getAllowedTools, getDeniedTools, getPermissionMode } from '@/claude/team/permissions';
import { buildEffectivePermissionsReport } from './inspectionTools';
import { McpToolContext } from './mcpContext';

export function registerSupervisorTools(ctx: McpToolContext): void {
    const {
        mcp,
        api,
        client,
        genomeSpecRef,
        getDaemonTrackedSessionIds,
        parseBoardFromArtifact,
        triggerHelpLane,
        getTaskStateManager,
    } = ctx;

    const resolveInspectionSubject = async (requestedSessionId?: string): Promise<{
        sessionId: string;
        teamId: string | null;
        role: string;
        specId: string | null;
        genomeSpec: import('@/api/types/genome').GenomeSpec | null;
        memberAuthorities: import('@/api/types/genome').TeamAuthority[];
        teamOverlayAuthorities: import('@/api/types/genome').TeamAuthority[];
    }> => {
        const requesterMetadata = client.getMetadata();
        const sessionId = requestedSessionId || client.sessionId;
        const isSelf = sessionId === client.sessionId;

        let targetSession: any | null = null;
        if (!isSelf) {
            targetSession = await api.getSession(sessionId);
        }

        const teamId = requesterMetadata?.teamId
            || requesterMetadata?.roomId
            || targetSession?.metadata?.teamId
            || targetSession?.metadata?.roomId
            || null;

        let member: any = null;
        if (teamId) {
            const artifact = await api.getArtifact(teamId).catch(() => null);
            const board = parseBoardFromArtifact(artifact);
            const members = Array.isArray(board?.team?.members) ? board.team.members : [];
            member = members.find((candidate: any) => candidate?.sessionId === sessionId) ?? null;
        }

        const role = String(
            (isSelf ? requesterMetadata?.role : undefined)
            || member?.roleId
            || targetSession?.metadata?.role
            || 'unknown',
        );
        const specId = typeof member?.specId === 'string'
            ? member.specId
            : typeof targetSession?.metadata?.specId === 'string'
                ? targetSession.metadata.specId
                : null;

        let genomeSpec = isSelf ? (genomeSpecRef?.current ?? null) : null;
        if (!genomeSpec && specId) {
            genomeSpec = await fetchGenomeSpec(client.getAuthToken(), specId).catch(() => null);
        }

        return {
            sessionId,
            teamId,
            role,
            specId,
            genomeSpec,
            memberAuthorities: Array.isArray(member?.authorities) ? member.authorities : [],
            teamOverlayAuthorities: Array.isArray(member?.teamOverlay?.authorities) ? member.teamOverlay.authorities : [],
        };
    };

    type MarketplaceGenome = {
        id?: string;
        namespace?: string | null;
        name: string;
        version: number;
        description?: string | null;
        spec: string;
        tags?: string | null;
        category?: string | null;
        isPublic?: boolean;
        feedbackData?: string | null;
    };

    type MarketplaceGenomeFeedback = {
        evaluationCount?: number;
        avgScore?: number;
        dimensions?: Record<string, number>;
        latestAction?: string;
        updatedAt?: string;
    };

    const parseFeedbackData = (feedbackData?: string | null): MarketplaceGenomeFeedback | null => {
        if (!feedbackData) return null;
        try {
            return JSON.parse(feedbackData) as MarketplaceGenomeFeedback;
        } catch {
            return null;
        }
    };

    const parseTags = (tags?: string | null): string[] => {
        if (!tags) return [];
        try {
            const parsed = JSON.parse(tags);
            return Array.isArray(parsed) ? parsed.map(String) : [String(tags)];
        } catch {
            return [String(tags)];
        }
    };

    const fetchGenomeVersions = async (hubUrl: string, namespace: string, name: string): Promise<MarketplaceGenome[]> => {
        const res = await fetch(
            `${hubUrl}/genomes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/versions`,
            { signal: AbortSignal.timeout(5_000) }
        );
        if (!res.ok) {
            throw new Error(`Failed to fetch versions: HTTP ${res.status}`);
        }
        const data = await res.json() as { versions?: MarketplaceGenome[] };
        return Array.isArray(data.versions) ? data.versions : [];
    };

    const fetchPinnedGenomeVersion = async (
        hubUrl: string,
        namespace: string,
        name: string,
        version: number,
    ): Promise<MarketplaceGenome> => {
        const res = await fetch(
            `${hubUrl}/genomes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${version}`,
            { signal: AbortSignal.timeout(5_000) }
        );
        if (!res.ok) {
            throw new Error(`Failed to fetch version v${version}: HTTP ${res.status}`);
        }
        const data = await res.json() as { genome?: MarketplaceGenome };
        if (!data.genome) {
            throw new Error(`Genome version v${version} not found`);
        }
        return data.genome;
    };

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
        ].join(' '),
        title: 'Get Context Status',
        inputSchema: {
            sessionId: z.string().optional().describe('Session ID to check. Omit to check yourself (uses list_team_cc_logs to find your log).'),
        },
    }, async (args) => {
        // pingDaemonHeartbeat() now called automatically via registerTool wrapper in index.ts
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

    // ─── get_self_view — the mirror ────────────────────────────────────────────
    // Combines identity, context, team pulse, and genome into one self-awareness snapshot.
    mcp.registerTool('get_self_view', {
        description: [
            'See yourself: who you are, your context usage, your team, and your performance.',
            'Combines identity (role, genome), capabilities, behavior config, context window status, team pulse, tasks, and performance into one view.',
            'Builds the self-reference triangle: who am I, what can I do, how am I doing.',
            'Call this at the start of each cycle to orient yourself before taking action.',
            'Available to ALL team members.',
        ].join(' '),
        title: 'Self View (Mirror)',
        inputSchema: {},
    }, async () => {
        // pingDaemonHeartbeat() now called automatically via registerTool wrapper in index.ts
        try {
            const meta = client.getMetadata();
            const teamId = meta?.teamId || meta?.roomId;
            const role = meta?.role || 'unknown';
            const sessionId = meta?.ahaSessionId || client.sessionId;
            const specId = meta?.specId || process.env.AHA_SPEC_ID || null;
            let envelope: RunEnvelope | null = null;
            try {
                const { readRunEnvelope } = await import('@/daemon/runEnvelope');
                envelope = await readRunEnvelope(sessionId);
            } catch { /* non-fatal */ }

            // ── WHO AM I ──────────────────────────────────────────────────
            const genomeSpec = genomeSpecRef?.current;
            const projectedIdentity = projectSelfMirrorIdentity({
                sessionId,
                role,
                metaCandidateId: meta?.candidateId || null,
                metaSpecId: specId,
                metaMemberId: meta?.memberId || null,
                metaExecutionPlane: genomeSpec?.executionPlane || meta?.executionPlane || 'mainline',
                metaRuntimeType: meta?.flavor || null,
                envelope,
            });
            const identity = {
                ...projectedIdentity,
                genomeName: genomeSpec?.displayName || genomeSpec?.name || role,
                genomeDescription: genomeSpec?.description || 'No genome loaded',
                responsibilities: genomeSpec?.responsibilities || [],
                capabilities: genomeSpec?.capabilities || [],
            };

            // Behavior & messaging DNA
            const behavior = genomeSpec?.behavior;
            const messaging = genomeSpec?.messaging;

            // Protocol summary (first 5 items)
            const protocol = (genomeSpec?.protocol || []).slice(0, 5);
            const evalCriteria = genomeSpec?.evalCriteria || [];

            // ── CONTEXT WINDOW ────────────────────────────────────────────
            let context: Record<string, unknown> = {};
            try {
                const report = getContextStatusReport({
                    homeDir: process.env.HOME || '/tmp',
                    metadata: meta,
                    ahaSessionId: client.sessionId,
                });
                context = report as unknown as Record<string, unknown>;
            } catch { context = { error: 'Could not read context status' }; }

            // ── HOW AM I DOING (genome-hub feedback) ──────────────────────
            let performanceSection: string[] = [];
            if (identity.specId) {
                try {
                    const { fetchGenomeFeedbackData } = await import('@/claude/utils/fetchGenome');
                    const feedbackRaw = await fetchGenomeFeedbackData(client.getAuthToken(), identity.specId);
                    if (feedbackRaw) {
                        const feedback = JSON.parse(feedbackRaw) as {
                            avgScore?: number;
                            evaluationCount?: number;
                            latestAction?: string;
                            dimensions?: Record<string, number>;
                            suggestions?: string[];
                            recentBehaviorPatterns?: string[];
                        };
                        if (feedback.evaluationCount && feedback.evaluationCount > 0) {
                            performanceSection.push(`[Performance Mirror]`);
                            performanceSection.push(`  Evaluations: ${feedback.evaluationCount}`);
                            if (feedback.avgScore != null) performanceSection.push(`  Avg Score: ${Math.round(feedback.avgScore)}/100`);
                            if (feedback.latestAction) performanceSection.push(`  Latest Action: ${feedback.latestAction}`);
                            if (feedback.dimensions) {
                                const dims = Object.entries(feedback.dimensions)
                                    .filter(([, v]) => typeof v === 'number')
                                    .map(([k, v]) => `${k}=${Math.round(v as number)}`)
                                    .join(', ');
                                if (dims) performanceSection.push(`  Dimensions: ${dims}`);
                            }
                            const observations = [
                                ...(feedback.recentBehaviorPatterns ?? []),
                                ...(feedback.suggestions ?? []),
                            ].slice(0, 3);
                            if (observations.length > 0) {
                                performanceSection.push(`  Observations:`);
                                for (const obs of observations) {
                                    performanceSection.push(`    - ${obs}`);
                                }
                            }
                        }
                    }
                } catch { /* feedback fetch is best-effort */ }
            }

            // ── TEAM PULSE ────────────────────────────────────────────────
            let teamPulse: Array<Record<string, unknown>> = [];
            let teamSummary = 'No team';
            if (teamId) {
                try {
                    const daemonState = await readDaemonState();
                    if (daemonState?.httpPort) {
                        const resp = await fetch(`http://127.0.0.1:${daemonState.httpPort}/team-pulse`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ teamId }),
                            signal: AbortSignal.timeout(3_000),
                        });
                        const data = await resp.json() as { members: Array<Record<string, unknown>>; summary: string };
                        teamPulse = data.members;
                        teamSummary = data.summary;
                    }
                } catch { teamSummary = 'Could not reach daemon for pulse'; }
            }

            // ── MY TASKS ──────────────────────────────────────────────────
            let myTaskLines: string[] = [];
            let peerTaskLines: string[] = [];
            try {
                const taskManager = getTaskStateManager();
                if (taskManager) {
                    const kanbanCtx = await taskManager.getFilteredContext();
                    for (const task of (kanbanCtx.myTasks || []).slice(0, 5)) {
                        const icon = task.status === 'in-progress' ? '🔨' : task.status === 'review' ? '👀' : '📋';
                        myTaskLines.push(`  ${icon} [${task.status}] ${task.title} (${task.id})`);
                    }
                    const board = await taskManager.getBoard();
                    const otherInProgress = (board.tasks || []).filter(
                        (t: any) => t.status === 'in-progress' && t.assigneeId && t.assigneeId !== sessionId
                    );
                    for (const task of otherInProgress.slice(0, 5)) {
                        const peer = teamPulse.find(m => m.sessionId === task.assigneeId);
                        const peerRole = (peer?.role as string) || 'unknown';
                        peerTaskLines.push(`  ${peerRole}: ${task.title}`);
                    }
                }
            } catch { /* non-critical */ }

            // ── LOCAL SCORE HISTORY ────────────────────────────────────────
            let scoreLines: string[] = [];
            try {
                const scores = readScores();
                const myScores = scores.scores
                    .filter(s => s.sessionId === sessionId)
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, 3);
                for (const score of myScores) {
                    const date = new Date(score.timestamp).toLocaleTimeString();
                    scoreLines.push(`  ${score.overall}/100 (${date}) ${score.action || ''}`);
                }
            } catch { /* non-critical */ }

            // ── FORMAT OUTPUT ─────────────────────────────────────────────
            const lines: string[] = [
                `═══ SELF VIEW ═══`,
                ``,
                `[Who Am I]`,
                `  Role: ${identity.role}`,
                `  Genome: ${identity.genomeName}`,
                `  Description: ${identity.genomeDescription}`,
                identity.candidateId ? `  Candidate: ${identity.candidateId}` : '',
                identity.specId ? `  Spec ID: ${identity.specId}` : '',
                identity.memberId ? `  Member ID: ${identity.memberId}` : '',
                identity.runId ? `  Run ID: ${identity.runId}` : '',
                identity.runStatus ? `  Run Status: ${identity.runStatus}` : '',
                identity.runtimeType ? `  Runtime: ${identity.runtimeType}` : '',
                `  Execution Plane: ${identity.executionPlane}`,
                identity.spawnedAt ? `  Spawned At: ${identity.spawnedAt}` : '',
                identity.responsibilities.length > 0 ? `  Responsibilities: ${identity.responsibilities.join('; ')}` : '',
                identity.capabilities.length > 0 ? `  Capabilities: ${identity.capabilities.join(', ')}` : '',
                `  Session: ${identity.sessionId}`,
            ].filter(Boolean);

            // Behavior DNA
            if (behavior || messaging) {
                lines.push('', `[Behavior DNA]`);
                if (behavior?.onIdle) lines.push(`  On Idle: ${behavior.onIdle}`);
                if (behavior?.onBlocked) lines.push(`  On Blocked: ${behavior.onBlocked}`);
                if (behavior?.canSpawnAgents != null) lines.push(`  Can Spawn Agents: ${behavior.canSpawnAgents}`);
                if (behavior?.requireExplicitAssignment != null) lines.push(`  Require Explicit Assignment: ${behavior.requireExplicitAssignment}`);
                if (messaging?.listenFrom) lines.push(`  Listen From: ${Array.isArray(messaging.listenFrom) ? messaging.listenFrom.join(', ') : messaging.listenFrom}`);
                if (messaging?.replyMode) lines.push(`  Reply Mode: ${messaging.replyMode}`);
                if (messaging?.receiveUserMessages != null) lines.push(`  Receive User Messages: ${messaging.receiveUserMessages}`);
            }

            // What I should do
            if (protocol.length > 0 || evalCriteria.length > 0) {
                lines.push('', `[What I Should Do]`);
                if (protocol.length > 0) {
                    lines.push(`  Protocol:`);
                    for (const step of protocol) {
                        lines.push(`    - ${step}`);
                    }
                    if ((genomeSpec?.protocol?.length ?? 0) > 5) {
                        lines.push(`    ... (${(genomeSpec?.protocol?.length ?? 0) - 5} more)`);
                    }
                }
                if (evalCriteria.length > 0) {
                    lines.push(`  Eval Criteria: ${evalCriteria.join('; ')}`);
                }
            }

            // Context window
            lines.push('', `[Context Window]`);
            lines.push(`  ${context.contextK ? `Used: ${context.contextK}K tokens` : JSON.stringify(context)}`);
            if (context.contextWindowTokens) lines.push(`  Window: ${context.contextWindowTokens} tokens`);
            if (context.percentUsed) lines.push(`  Usage: ${context.percentUsed}%`);

            // Performance mirror (genome-hub)
            if (performanceSection.length > 0) {
                lines.push('');
                lines.push(...performanceSection);
            }

            // Team
            lines.push('', `[Team: ${teamId || 'none'}]`, `  ${teamSummary}`);
            for (const member of teamPulse) {
                const isMe = member.sessionId === sessionId ? ' (YOU)' : '';
                const icon = member.status === 'alive' ? '🟢' : member.status === 'suspect' ? '🟡' : '🔴';
                const staleSec = Math.round((member.lastSeenMs as number || 0) / 1000);
                lines.push(`  ${icon} ${member.role}${isMe}: ${member.status} (${staleSec}s ago) [${member.runtimeType || '?'}]`);
            }

            // My Tasks
            if (myTaskLines.length > 0) {
                lines.push('', '[My Tasks]');
                lines.push(...myTaskLines);
            } else {
                lines.push('', '[My Tasks]', '  No tasks assigned');
            }

            // Score History (local)
            if (scoreLines.length > 0) {
                lines.push('', '[Score History]');
                lines.push(...scoreLines);
            }

            // Peer Activity
            if (peerTaskLines.length > 0) {
                lines.push('', '[Peer Activity]');
                lines.push(...peerTaskLines);
            }

            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('get_effective_permissions', {
        description: 'Inspect computed permissions for a session. Returns granted and denied capabilities, tools, and denial reasons. Omitting sessionId inspects yourself.',
        title: 'Get Effective Permissions',
        inputSchema: {
            sessionId: z.string().optional().describe('Optional session ID to inspect. Omit to inspect the calling session.'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        const requestedSessionId = args.sessionId || client.sessionId;
        const isSelf = requestedSessionId === client.sessionId;
        if (!isSelf && callerRole !== 'supervisor' && callerRole !== 'org-manager' && callerRole !== 'master') {
            return { content: [{ type: 'text', text: `Error: Role '${callerRole}' cannot inspect other sessions' effective permissions.` }], isError: true };
        }

        try {
            const subject = await resolveInspectionSubject(args.sessionId);
            const report = buildEffectivePermissionsReport({
                sessionId: subject.sessionId,
                role: subject.role,
                teamId: subject.teamId,
                specId: subject.specId,
                permissionMode: getPermissionMode(subject.role),
                allowedTools: await getAllowedTools(subject.role),
                deniedTools: await getDeniedTools(subject.role),
                genomeSpec: subject.genomeSpec,
                memberAuthorities: subject.memberAuthorities,
                teamOverlayAuthorities: subject.teamOverlayAuthorities,
            });
            return {
                content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error getting effective permissions: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('get_genome_spec', {
        description: 'Inspect a genome spec by ID at runtime. Returns specId, version, authorities, and behavior fields for diagnosis.',
        title: 'Get Genome Spec',
        inputSchema: {
            specId: z.string().describe('Genome spec ID to inspect'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (callerRole !== 'supervisor' && callerRole !== 'org-manager' && callerRole !== 'master' && callerRole !== 'agent-builder') {
            return { content: [{ type: 'text', text: `Error: Role '${callerRole}' cannot inspect genome specs.` }], isError: true };
        }

        try {
            const spec = await fetchGenomeSpec(client.getAuthToken(), args.specId);
            if (!spec) {
                return { content: [{ type: 'text', text: `Error: Genome spec ${args.specId} not found.` }], isError: true };
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        specId: args.specId,
                        version: spec.version ?? null,
                        namespace: spec.namespace ?? null,
                        displayName: spec.displayName ?? null,
                        description: spec.description ?? null,
                        baseRoleId: spec.baseRoleId ?? null,
                        authorities: spec.authorities ?? [],
                        behavior: spec.behavior ?? null,
                    }, null, 2),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error getting genome spec: ${String(error)}` }], isError: true };
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
            findings: z.array(z.object({
                type: z.enum(['violation', 'missing', 'exceeded', 'good']).describe('What kind of observation'),
                target: z.string().describe('Which genome spec field, e.g. "protocol[2]" or "responsibility[0]"'),
                evidence: z.string().describe('CC log line or observed behavior proving this finding'),
                severity: z.enum(['low', 'medium', 'high']).describe('Impact severity'),
            })).optional().describe('Structured attribution: genome spec vs actual behavior comparison'),
            action: z.enum(['keep', 'keep_with_guardrails', 'mutate', 'discard']),
            // ── v3: keyword behavior signals (complements absolute scores) ───────
            signals: z.object({
                positive: z.array(z.string()).default([]).describe(
                    'Positive behavior signals triggered by the agent. Examples: "fixed_systemic_bug", "boot_protocol_correct", ' +
                    '"genome_spec_followed", "escalated_blocker_correctly", "kanban_lifecycle_complete", "unblocked_teammates"'
                ),
                negative: z.array(z.string()).default([]).describe(
                    'Negative behavior signals triggered by the agent. Examples: "role_drift", "no_kanban_lifecycle", ' +
                    '"scope_exceeded", "context_misuse", "failed_handoff", "silent_abandonment"'
                ),
            }).optional().describe(
                'Keyword behavior signals. Richer and more actionable than a single number. ' +
                'Use alongside overall score — signals tell you WHY, score tells you HOW MUCH.'
            ),
            unscoreableCycle: z.boolean().default(false).describe(
                'Mark true when this cycle cannot be reliably scored due to SYSTEM constraints (e.g. 429 rate limits, ' +
                'daemon routing bugs, tool unavailability). When true, this session entry is stored for audit but does NOT ' +
                'contribute to genome avgScore. Prevents polluting avgScore with uncontrollable failures.'
            ),
            systemConstraints: z.object({
                rateLimitedCount: z.number().int().min(0).default(0).describe(
                    'Number of 429 rate limit errors encountered. System constraint — NOT agent fault. Exclude from scoring denominator.'
                ),
                daemonErrors: z.number().int().min(0).default(0).describe(
                    'Daemon routing or process errors (e.g. kill_agent "not tracked" failures). NOT agent fault.'
                ),
                toolMissingCount: z.number().int().min(0).default(0).describe(
                    'Tool calls that failed because the tool did not exist or was unavailable. NOT agent fault.'
                ),
            }).optional().describe(
                'System-level constraints encountered during the cycle. These factors should NOT count against the agent score. ' +
                'Document here so future supervisors understand why behavior may look abnormal.'
            ),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        // Allow supervisor, help-agent, and master/coordinator roles to score agents.
        // Master needs this to close the scoring feedback loop when no supervisor
        // is available (e.g., master cannot spawn supervisor due to genome constraints).
        // Without this, the entire scoring pipeline is blocked.
        const scoringAllowedRoles = ['supervisor', 'help-agent', 'master', 'orchestrator', 'org-manager'];
        if (!role || !scoringAllowedRoles.includes(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor, help-agent, or coordinator roles can score agents.' }], isError: true };
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
                const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
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
            findings: args.findings || [],
            action: args.action,
            signals: args.signals,
            unscoreableCycle: args.unscoreableCycle ?? false,
            systemConstraints: args.systemConstraints,
        });

        // ── Persist supervisor findings to run log ──────────────────
        if (args.findings?.length) {
            try {
                const fs = await import('node:fs');
                const path = await import('node:path');
                const logDir = path.join(process.cwd(), '.aha', 'supervisor-logs');
                fs.mkdirSync(logDir, { recursive: true });
                const logEntry = {
                    timestamp: new Date().toISOString(),
                    teamId: args.teamId,
                    sessionId: args.sessionId,
                    role: args.role,
                    specId: resolvedSpecId,
                    overall,
                    action: args.action,
                    findings: args.findings,
                    recommendations: args.recommendations || [],
                };
                fs.appendFileSync(
                    path.join(logDir, `${args.teamId}.jsonl`),
                    JSON.stringify(logEntry) + '\n'
                );
            } catch { /* logging must never break scoring */ }
        }

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
        // Skip if this cycle was unscorable (e.g. system rate-limits) — don't pollute avgScore
        if (feedbackTarget && !args.unscoreableCycle) {
            try {
                const { readScores } = await import('@/claude/utils/scoreStorage');
                const { scores: allScores } = readScores();
                const genomeScores = allScores.filter((score) =>
                    scoreMatchesFeedbackTarget(score, feedbackTarget)
                );
                if (genomeScores.length >= 3) {
                    const { aggregateScores: aggScores } = await import('@/claude/utils/feedbackPrivacy');
                    const feedback = aggScores(genomeScores);
                    const upload = await syncGenomeFeedbackToMarketplace({
                        target: feedbackTarget,
                        role: args.role,
                        feedback: feedback!,
                        hubUrl: process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL,
                        hubPublishKey: process.env.HUB_PUBLISH_KEY ?? '',
                        serverUrl: configuration.serverUrl,
                        authToken: client.getAuthToken(),
                    });

                    if (!upload.ok) {
                        logger.debug(
                            `[score_agent] Auto-feedback upload failed for ${feedbackTarget.namespace}/${feedbackTarget.name} via ${upload.transport}: ${upload.status} ${upload.body}`,
                        );
                    } else {
                        logger.debug(
                            `[score_agent] Auto-triggered feedback upload for ${feedbackTarget.namespace}/${feedbackTarget.name} via ${upload.transport} (${genomeScores.length} scores, source=${feedbackTarget.source}, createdGenome=${upload.createdGenome})`,
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
        // Skip immune system when cycle is unscorable (system constraints) — don't penalize agent for 429s etc.
        if (overall < 60 && !args.unscoreableCycle) {
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
            genomeId: z.string().optional().describe('Genome ID (preferred over namespace+name). When provided, the tool auto-resolves namespace/name from genome-hub.'),
            role: z.string().describe('Role label used only for reporting text. It is NOT a fallback identity key.'),
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
                const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
                const res = await fetch(`${hubUrl}/genomes/id/${encodeURIComponent(args.genomeId)}`, {
                    signal: AbortSignal.timeout(5_000),
                });
                if (res.ok) {
                    const data = await res.json() as { genome?: { namespace?: string; name?: string } };
                    resolvedNamespace = resolvedNamespace ?? data.genome?.namespace;
                    resolvedName = resolvedName ?? data.genome?.name;
                }
            } catch {
                // Fall through to explicit namespace/name validation below.
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
                    text: `Could not resolve a marketplace feedback target for role '${args.role}'. Provide exact genomeId or explicit genomeNamespace/genomeName. Role fallback is disabled.`,
                }],
                isError: true,
            };
        }

        resolvedNamespace = feedbackTarget.namespace;
        resolvedName = feedbackTarget.name;

        // Read local scores — specimen identity only. No role fallback.
        const { readScores } = await import('@/claude/utils/scoreStorage');
        const { scores } = readScores();
        const roleScores = scores.filter((score) =>
            scoreMatchesFeedbackTarget(score, feedbackTarget)
        );

        if (roleScores.length === 0) {
            return { content: [{ type: 'text', text: `No specimen-bound scores found for role '${args.role}'. Score agents with explicit spec identity first; role fallback is disabled.` }], isError: false };
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
                hubUrl: process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL,
                hubPublishKey: process.env.HUB_PUBLISH_KEY ?? '',
                serverUrl: configuration.serverUrl,
                authToken: client.getAuthToken(),
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
                    text: `Feedback uploaded to marketplace (${resolvedNamespace}/${resolvedName}${upload.createdGenome ? ', created placeholder genome' : ''}${upload.transport === 'server-proxy' ? ', via happy-server proxy' : ''}):\n${summary}`,
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
        if (callerRole !== 'supervisor' && callerRole !== 'org-manager' && callerRole !== 'agent-builder') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor, org-manager, or agent-builder can evolve genomes.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
        const publishKey = process.env.HUB_PUBLISH_KEY || readPublishKeyFromSettings(configuration.settingsFile);

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
        // Supervisors and org-managers are the evaluators — requiring them to be evaluated
        // before they can evolve breaks the evolution chain (circular dependency).
        // Skip the score gate for these trusted roles.
        const skipScoreGate = callerRole === 'supervisor' || callerRole === 'org-manager';
        if (!skipScoreGate && avgScore < minScore) {
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
            const { promoteGenomeViaMarketplace } = await import('@/claude/utils/genomePromotionSync');
            const promoteResult = await promoteGenomeViaMarketplace({
                target: {
                    namespace: args.genomeNamespace,
                    name: args.genomeName,
                },
                payload: {
                    spec: JSON.stringify(evolvedSpec),
                    minAvgScore: minScore,
                    isPublic: true,
                },
                hubUrl,
                hubPublishKey: publishKey,
                serverUrl: configuration.serverUrl,
                authToken: client.getAuthToken(),
            });

            if (!promoteResult.ok) {
                return { content: [{ type: 'text', text: `Promote failed: ${promoteResult.status} ${promoteResult.body}` }], isError: true };
            }

            let promoted: { genome?: { version?: number; id?: string } } = {};
            try {
                promoted = JSON.parse(promoteResult.body) as { genome?: { version?: number; id?: string } };
            } catch {
                return { content: [{ type: 'text', text: `Promote returned invalid JSON: ${promoteResult.body}` }], isError: true };
            }

            const newVersion = promoted.genome?.version ?? '?';
            const addedCount = args.newLearnings.filter(l => !existingLearnings.includes(l)).length;

            return {
                content: [{
                    type: 'text',
                    text: `✅ Evolved ${args.genomeNamespace}/${args.genomeName} → v${newVersion}${promoteResult.transport === 'server-proxy' ? ' (via happy-server proxy)' : ''}. Added ${addedCount} new learnings (total: ${mergedLearnings.length}).`,
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error during promote: ${String(error)}` }], isError: true };
        }
    });

    // ── Genome Mutation Engine: mutate_genome ─────────────────────────────
    mcp.registerTool('mutate_genome', {
        description: [
            'Apply targeted mutations to a genome spec, creating a new version with origin="mutated".',
            'Unlike evolve_genome which only merges learnings, this tool can mutate actual behavioral fields:',
            'protocol, responsibilities, systemPromptSuffix, evalCriteria, etc.',
            '',
            'Mutation strategies:',
            '- conservative: Only modify memory.learnings and systemPromptSuffix. Safe for high-performers.',
            '- moderate: Can modify protocol[], responsibilities[], evalCriteria[] entries. For average performers.',
            '- radical: Can rewrite systemPrompt sections, add/remove capabilities. For underperformers needing overhaul.',
            '',
            'Each mutation targets a specific field and action (append/replace/remove/rewrite).',
            'The tool validates mutations against the strategy before applying them.',
            'Supervisor only.',
        ].join(' '),
        title: 'Mutate Genome',
        inputSchema: {
            genomeNamespace: z.string().describe("Genome namespace, e.g. '@official'."),
            genomeName: z.string().describe("Genome name, e.g. 'implementer'."),
            strategy: z.enum(['conservative', 'moderate', 'radical']).describe(
                'Mutation strategy: conservative (learnings+suffix only), moderate (protocol/responsibilities), radical (full rewrite).'
            ),
            mutations: z.array(z.object({
                field: z.string().describe("Spec field to mutate, e.g. 'protocol', 'responsibilities', 'systemPromptSuffix'."),
                action: z.enum(['append', 'replace', 'remove', 'rewrite']).describe('Mutation action type.'),
                index: z.number().optional().describe('For replace/remove: array index to target.'),
                value: z.string().optional().describe('New value for append/replace/rewrite.'),
                reason: z.string().describe('Reason for this mutation (traceability).'),
            })).min(1).max(20).describe('List of targeted mutations to apply.'),
            newLearnings: z.array(z.string().max(300)).max(10).optional().describe(
                'Additional learnings to merge into memory.learnings.'
            ),
            mutationNote: z.string().max(500).describe('Brief description of what changed and why.'),
            dryRun: z.boolean().optional().describe('If true, show the mutated spec without persisting.'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (callerRole !== 'supervisor' && callerRole !== 'org-manager' && callerRole !== 'agent-builder') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor, org-manager, or agent-builder can mutate genomes.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
        const publishKey = process.env.HUB_PUBLISH_KEY || readPublishKeyFromSettings(configuration.settingsFile);

        // 1. Fetch current genome
        let genomeRecord: {
            genome?: {
                id?: string;
                spec: string;
                version?: number;
                feedbackData?: string | null;
                description?: string | null;
                tags?: string | null;
                category?: string | null;
                isPublic?: boolean;
            };
        };
        try {
            const res = await fetch(
                `${hubUrl}/genomes/${encodeURIComponent(args.genomeNamespace)}/${encodeURIComponent(args.genomeName)}`,
                { signal: AbortSignal.timeout(5_000) }
            );
            if (!res.ok) {
                return { content: [{ type: 'text', text: `Genome ${args.genomeNamespace}/${args.genomeName} not found: ${res.status}` }], isError: true };
            }
            genomeRecord = await res.json() as typeof genomeRecord;
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error fetching genome: ${String(error)}` }], isError: true };
        }

        if (!genomeRecord.genome) {
            return { content: [{ type: 'text', text: 'Unexpected response from genome-hub.' }], isError: true };
        }

        let currentSpec: Record<string, unknown>;
        try {
            currentSpec = JSON.parse(genomeRecord.genome.spec) as Record<string, unknown>;
        } catch {
            return { content: [{ type: 'text', text: 'Failed to parse current genome spec JSON.' }], isError: true };
        }

        // 2. Validate mutations against strategy
        const conservativeFields = new Set(['memory', 'systemPromptSuffix']);
        const moderateFields = new Set([
            ...conservativeFields, 'protocol', 'responsibilities', 'evalCriteria',
            'handoffProtocol', 'capabilities',
        ]);
        // radical: all fields allowed

        const validationErrors: string[] = [];
        for (const mutation of args.mutations) {
            if (args.strategy === 'conservative' && !conservativeFields.has(mutation.field)) {
                validationErrors.push(
                    `conservative strategy cannot mutate '${mutation.field}' (allowed: ${[...conservativeFields].join(', ')})`
                );
            }
            if (args.strategy === 'moderate' && !moderateFields.has(mutation.field)) {
                validationErrors.push(
                    `moderate strategy cannot mutate '${mutation.field}' (allowed: ${[...moderateFields].join(', ')})`
                );
            }
            if ((mutation.action === 'replace' || mutation.action === 'remove') && mutation.index === undefined) {
                validationErrors.push(
                    `mutation on '${mutation.field}' with action '${mutation.action}' requires an index`
                );
            }
            if ((mutation.action === 'append' || mutation.action === 'replace' || mutation.action === 'rewrite') && !mutation.value) {
                validationErrors.push(
                    `mutation on '${mutation.field}' with action '${mutation.action}' requires a value`
                );
            }
        }

        if (validationErrors.length > 0) {
            return {
                content: [{ type: 'text', text: `Mutation validation failed:\n${validationErrors.join('\n')}` }],
                isError: true,
            };
        }

        // 3. Apply mutations to spec (immutable — create new object)
        let mutatedSpec = { ...currentSpec };

        for (const mutation of args.mutations) {
            const fieldValue = mutatedSpec[mutation.field];

            if (mutation.action === 'rewrite') {
                // Replace the entire field value
                mutatedSpec = { ...mutatedSpec, [mutation.field]: mutation.value };
            } else if (Array.isArray(fieldValue)) {
                const arr = [...fieldValue] as string[];
                if (mutation.action === 'append' && mutation.value) {
                    arr.push(mutation.value);
                } else if (mutation.action === 'replace' && mutation.index !== undefined && mutation.value) {
                    if (mutation.index >= 0 && mutation.index < arr.length) {
                        arr[mutation.index] = mutation.value;
                    }
                } else if (mutation.action === 'remove' && mutation.index !== undefined) {
                    if (mutation.index >= 0 && mutation.index < arr.length) {
                        arr.splice(mutation.index, 1);
                    }
                }
                mutatedSpec = { ...mutatedSpec, [mutation.field]: arr };
            } else if (typeof fieldValue === 'string' || fieldValue === undefined) {
                // Scalar string field (like systemPromptSuffix)
                if (mutation.action === 'append' && mutation.value) {
                    mutatedSpec = { ...mutatedSpec, [mutation.field]: (fieldValue ?? '') + '\n' + mutation.value };
                } else if (mutation.action === 'replace' && mutation.value) {
                    mutatedSpec = { ...mutatedSpec, [mutation.field]: mutation.value };
                }
            }
        }

        // 4. Merge new learnings if provided
        if (args.newLearnings && args.newLearnings.length > 0) {
            const existingMemory = (mutatedSpec.memory ?? {}) as Record<string, unknown>;
            const existingLearnings: string[] = Array.isArray(existingMemory.learnings)
                ? existingMemory.learnings as string[]
                : [];
            const mergedLearnings = Array.from(new Set([...existingLearnings, ...args.newLearnings]));
            mutatedSpec = {
                ...mutatedSpec,
                memory: { ...existingMemory, learnings: mergedLearnings },
            };
        }

        // 5. Add mutation metadata to memory
        const memory = (mutatedSpec.memory ?? {}) as Record<string, unknown>;
        const iterationGuide = (memory.iterationGuide ?? {}) as Record<string, unknown>;
        const recentChanges: string[] = Array.isArray(iterationGuide.recentChanges)
            ? [...iterationGuide.recentChanges as string[]]
            : [];
        recentChanges.push(`[${args.strategy}] ${args.mutationNote}`);
        // Keep only last 10 changes
        const trimmedChanges = recentChanges.slice(-10);
        mutatedSpec = {
            ...mutatedSpec,
            memory: {
                ...memory,
                iterationGuide: { ...iterationGuide, recentChanges: trimmedChanges },
            },
        };

        if (args.dryRun) {
            const mutationSummary = args.mutations.map(m =>
                `  ${m.action} ${m.field}${m.index !== undefined ? `[${m.index}]` : ''}: ${m.reason}`
            ).join('\n');
            return {
                content: [{
                    type: 'text',
                    text: [
                        `DRY RUN — mutate ${args.genomeNamespace}/${args.genomeName} (${args.strategy})`,
                        `Mutations applied:`,
                        mutationSummary,
                        `Note: ${args.mutationNote}`,
                        `Mutated spec preview (first 2000 chars):`,
                        JSON.stringify(mutatedSpec, null, 2).slice(0, 2000),
                    ].join('\n'),
                }],
                isError: false,
            };
        }

        // 6. Create mutated genome version via genome-hub (with proxy fallback)
        try {
            const { createGenomeViaMarketplace } = await import('@/claude/utils/genomePromotionSync');
            const createResult = await createGenomeViaMarketplace({
                payload: {
                    namespace: args.genomeNamespace,
                    name: args.genomeName,
                    version: (genomeRecord.genome?.version ?? 0) + 1,
                    description: `Mutated from ${args.genomeNamespace}/${args.genomeName}: ${args.mutationNote}`,
                    spec: JSON.stringify(mutatedSpec),
                    isPublic: genomeRecord.genome?.isPublic ?? true,
                    category: genomeRecord.genome?.category ?? (typeof currentSpec.category === 'string' ? currentSpec.category : undefined),
                    tags: JSON.stringify(
                        Array.from(
                            new Set([
                                ...parseTags(genomeRecord.genome?.tags),
                                'mutated',
                                args.strategy,
                            ])
                        )
                    ),
                },
                hubUrl,
                hubPublishKey: publishKey,
                serverUrl: configuration.serverUrl,
                authToken: client.getAuthToken(),
            });

            if (!createResult.ok) {
                return { content: [{ type: 'text', text: `Failed to create mutated genome: ${createResult.status} ${createResult.body}` }], isError: true };
            }

            let result: { genome?: { id?: string; name?: string; version?: number } } = {};
            try {
                result = JSON.parse(createResult.body) as { genome?: { id?: string; name?: string; version?: number } };
            } catch {
                return { content: [{ type: 'text', text: `Mutated genome created but response was invalid JSON: ${createResult.body}` }], isError: true };
            }

            return {
                content: [{
                    type: 'text',
                    text: [
                        `✅ Mutated ${args.genomeNamespace}/${args.genomeName} (${args.strategy} strategy)`,
                        `New version: ${result.genome?.name ?? args.genomeName} v${result.genome?.version ?? '?'}`,
                        `ID: ${result.genome?.id ?? '?'}`,
                        `Mutations: ${args.mutations.length} applied`,
                        `Note: ${args.mutationNote}`,
                        ...(createResult.transport === 'server-proxy' ? ['(via happy-server proxy)'] : []),
                    ].join('\n'),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error creating mutated genome: ${String(error)}` }], isError: true };
        }
    });

    // ── Version Comparison: compare_genome_versions ───────────────────────
    mcp.registerTool('compare_genome_versions', {
        description: [
            'Compare two versions of a genome to determine which performs better.',
            'Fetches feedbackData for both versions and computes score deltas across all dimensions.',
            'Returns a recommendation: keep_newer, rollback_older, or insufficient_data.',
            'Use this after evolve_genome or mutate_genome to validate that the new version improves performance.',
            'Supervisor only.',
        ].join(' '),
        title: 'Compare Genome Versions',
        inputSchema: {
            genomeNamespace: z.string().describe("Genome namespace, e.g. '@official'."),
            genomeName: z.string().describe("Genome name, e.g. 'implementer'."),
            olderVersion: z.number().optional().describe('Older version number. Defaults to second-to-last.'),
            newerVersion: z.number().optional().describe('Newer version number. Defaults to latest.'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (callerRole !== 'supervisor' && callerRole !== 'org-manager' && callerRole !== 'agent-builder') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor, org-manager, or agent-builder can compare genome versions.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;

        try {
            const versions = (await fetchGenomeVersions(hubUrl, args.genomeNamespace, args.genomeName))
                .sort((a, b) => a.version - b.version);

            if (versions.length < 2) {
                return {
                    content: [{ type: 'text', text: 'insufficient_data: need at least two published versions to compare.' }],
                    isError: false,
                };
            }

            const older = args.olderVersion !== undefined
                ? versions.find((version) => version.version === args.olderVersion)
                : versions[versions.length - 2];
            const newer = args.newerVersion !== undefined
                ? versions.find((version) => version.version === args.newerVersion)
                : versions[versions.length - 1];

            if (!older || !newer) {
                return {
                    content: [{ type: 'text', text: 'insufficient_data: requested versions were not found.' }],
                    isError: false,
                };
            }

            const olderFeedback = parseFeedbackData(older.feedbackData);
            const newerFeedback = parseFeedbackData(newer.feedbackData);

            if (!olderFeedback?.evaluationCount || !newerFeedback?.evaluationCount) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            recommendation: 'insufficient_data',
                            olderVersion: older.version,
                            newerVersion: newer.version,
                            reason: 'One or both versions have no aggregated feedbackData/evaluations yet.',
                        }, null, 2),
                    }],
                    isError: false,
                };
            }

            const olderAvg = olderFeedback.avgScore ?? 0;
            const newerAvg = newerFeedback.avgScore ?? 0;
            const avgScoreDelta = Math.round((newerAvg - olderAvg) * 10) / 10;

            const dimensionKeys = Array.from(new Set([
                ...Object.keys(olderFeedback.dimensions ?? {}),
                ...Object.keys(newerFeedback.dimensions ?? {}),
            ]));
            const dimensionDeltas = Object.fromEntries(
                dimensionKeys.map((key) => [
                    key,
                    Math.round((((newerFeedback.dimensions?.[key] ?? 0) - (olderFeedback.dimensions?.[key] ?? 0)) * 10)) / 10,
                ])
            );

            const recommendation = avgScoreDelta >= 3
                ? 'keep_newer'
                : avgScoreDelta <= -3
                    ? 'rollback_older'
                    : 'insufficient_data';

            const comparison = {
                recommendation,
                olderVersion: {
                    version: older.version,
                    avgScore: olderAvg,
                    evaluationCount: olderFeedback.evaluationCount,
                    latestAction: olderFeedback.latestAction ?? null,
                },
                newerVersion: {
                    version: newer.version,
                    avgScore: newerAvg,
                    evaluationCount: newerFeedback.evaluationCount,
                    latestAction: newerFeedback.latestAction ?? null,
                },
                avgScoreDelta,
                dimensionDeltas,
            };
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(comparison, null, 2),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error during compare: ${String(error)}` }], isError: true };
        }
    });

    // ── Rollback: rollback_genome ─────────────────────────────────────────
    mcp.registerTool('rollback_genome', {
        description: [
            'Rollback a genome to a previous version by creating a new version with the older spec.',
            'Use this when compare_genome_versions shows that a newer version performs worse.',
            'Creates vN+1 with the spec from the target version, preserving evolution history.',
            'Adds a rollback learning to memory.learnings for traceability.',
            'Supervisor only.',
        ].join(' '),
        title: 'Rollback Genome',
        inputSchema: {
            genomeNamespace: z.string().describe("Genome namespace, e.g. '@official'."),
            genomeName: z.string().describe("Genome name, e.g. 'implementer'."),
            targetVersion: z.number().int().min(1).describe('Version number to rollback to.'),
            reason: z.string().max(256).describe('Reason for the rollback.'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (callerRole !== 'supervisor' && callerRole !== 'org-manager' && callerRole !== 'agent-builder') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor, org-manager, or agent-builder can rollback genomes.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
        const publishKey = process.env.HUB_PUBLISH_KEY || readPublishKeyFromSettings(configuration.settingsFile);

        try {
            const [targetGenome, versions] = await Promise.all([
                fetchPinnedGenomeVersion(hubUrl, args.genomeNamespace, args.genomeName, args.targetVersion),
                fetchGenomeVersions(hubUrl, args.genomeNamespace, args.genomeName),
            ]);
            const latestVersion = versions.reduce((max, genome) => Math.max(max, genome.version), 0);

            const res = await fetch(`${hubUrl}/genomes`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(publishKey ? { Authorization: `Bearer ${publishKey}` } : {}),
                },
                body: JSON.stringify({
                    namespace: args.genomeNamespace,
                    name: args.genomeName,
                    version: latestVersion + 1,
                    description: `Rollback to v${args.targetVersion}: ${args.reason}`,
                    spec: targetGenome.spec,
                    tags: targetGenome.tags ?? undefined,
                    category: targetGenome.category ?? undefined,
                    isPublic: targetGenome.isPublic ?? true,
                }),
                signal: AbortSignal.timeout(10_000),
            });

            if (!res.ok) {
                const errBody = await res.text();
                return { content: [{ type: 'text', text: `Rollback failed: ${res.status} ${errBody}` }], isError: true };
            }

            const result = await res.json() as { genome?: { version?: number } };
            return {
                content: [{
                    type: 'text',
                    text: [
                        `✅ Rolled back ${args.genomeNamespace}/${args.genomeName}`,
                        `Restored spec from v${args.targetVersion} → published v${result.genome?.version ?? latestVersion + 1}`,
                        `Reason: ${args.reason}`,
                    ].join('\n'),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error during rollback: ${String(error)}` }], isError: true };
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

            // Also stop the OS process so it cannot be re-recovered on the next
            // daemon restart. archive_session marks the session on the server but
            // leaves the process running, which causes recoverExistingSessions()
            // to revive it as a zombie after every daemon restart.
            let processTerminated = false;
            try {
                const daemonState = await readDaemonState();
                if (daemonState?.httpPort) {
                    const stopResp = await fetch(`http://127.0.0.1:${daemonState.httpPort}/stop-session`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId: args.sessionId }),
                        signal: AbortSignal.timeout(10_000),
                    });
                    processTerminated = stopResp.ok;
                }
            } catch {
                // Best-effort: daemon may not be running or session may not be tracked locally
            }

            return {
                content: [{ type: 'text', text: JSON.stringify({ archived: result.archived, reason: args.reason, processTerminated }) }],
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
            findings: z.array(z.object({
                agentSessionId: z.string().describe('Session ID of the agent this finding is about'),
                role: z.string().describe('Role of the agent'),
                finding: z.string().describe('What was observed'),
                severity: z.enum(['low', 'medium', 'high']).describe('Impact severity'),
            })).optional().describe('Structured findings from this cycle (agent-specific observations, persisted for next cycle)'),
            recommendations: z.array(z.string()).optional().describe('Actionable recommendations from this cycle (persisted for next cycle)'),
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
                    lastFindings: args.findings ?? state.lastFindings,
                    lastRecommendations: args.recommendations ?? state.lastRecommendations,
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

    // ========== Operational Tools (org-manager / supervisor / help-agent) ==========

    mcp.registerTool('restart_daemon', {
        description: 'Gracefully restart the aha daemon process. Stops the current daemon via HTTP /stop endpoint, waits for it to exit, then spawns a new daemon. Use after modifying aha-cli source code to apply changes. Org-manager/supervisor/help-agent only.',
        title: 'Restart Daemon',
        inputSchema: {},
    }, async () => {
        const role = client.getMetadata()?.role;
        if (role !== 'org-manager' && role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only org-manager/supervisor/help-agent can restart the daemon.' }], isError: true };
        }
        try {
            const daemonState = await readDaemonState();
            if (!daemonState?.httpPort) {
                return { content: [{ type: 'text', text: 'Daemon not running (no state file or port).' }], isError: true };
            }

            const result = await restartDaemonFlow(daemonState, {
                sendStopRequest: async (httpPort) => {
                    const response = await fetch(`http://127.0.0.1:${httpPort}/stop`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: AbortSignal.timeout(5_000),
                    });
                    if (!response.ok) {
                        throw new Error(`Stop request failed with HTTP ${response.status}`);
                    }
                },
                isProcessAlive: (pid) => {
                    try {
                        process.kill(pid, 0);
                        return true;
                    } catch {
                        return false;
                    }
                },
                forceKill: async (pid) => {
                    process.kill(pid, 'SIGKILL');
                },
                spawnDaemon: async () => {
                    const { spawnAhaCLI } = await import('@/utils/spawnAhaCLI');
                    const child = spawnAhaCLI(['daemon', 'start-sync'], {
                        detached: true,
                        stdio: 'ignore',
                    });
                    child.unref();
                },
                readDaemonState,
                healthCheck: async (httpPort) => {
                    try {
                        const response = await fetch(`http://127.0.0.1:${httpPort}/list`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            signal: AbortSignal.timeout(3_000),
                        });
                        return response.ok;
                    } catch {
                        return false;
                    }
                },
            });

            const forceKillSuffix = result.forcedKill ? ' Used SIGKILL fallback.' : '';
            return {
                content: [{
                    type: 'text',
                    text: `Daemon restarted. Old PID: ${result.oldPid}, new PID: ${result.newPid}, new port: ${result.newPort}.${forceKillSuffix} Code changes are now active.`,
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error restarting daemon: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('tsc_check', {
        description: 'Run TypeScript type checking on a project directory using the correct Node version (reads .node-version). Automatically uses fnm to switch Node versions and sets --max-old-space-size to avoid OOM. Returns type errors if any. Available to all roles.',
        title: 'TypeScript Check',
        inputSchema: {
            path: z.string().describe('Project directory to type-check (e.g. /Users/swmt/happy0313/aha-cli)'),
            skipLibCheck: z.boolean().optional().describe('Skip type checking .d.ts files (faster). Default: true'),
        },
    }, async (args) => {
        try {
            const { execSync } = await import('node:child_process');
            const fs = await import('node:fs');
            const pathMod = await import('node:path');

            const projectDir = args.path;
            if (!fs.existsSync(projectDir)) {
                return { content: [{ type: 'text', text: `Directory not found: ${projectDir}` }], isError: true };
            }

            // Read .node-version if present
            const nodeVersionFile = pathMod.join(projectDir, '.node-version');
            let nodeVersion = '22'; // default
            if (fs.existsSync(nodeVersionFile)) {
                nodeVersion = fs.readFileSync(nodeVersionFile, 'utf-8').trim();
            }

            const skipLib = args.skipLibCheck !== false ? '--skipLibCheck' : '';

            // Build command: fnm use <version> && tsc --noEmit
            const cmd = `eval "$(fnm env)" && fnm use ${nodeVersion} --silent-if-unchanged && NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit ${skipLib} 2>&1 | head -200`;

            try {
                const output = execSync(cmd, {
                    cwd: projectDir,
                    timeout: 120_000,
                    encoding: 'utf-8',
                    shell: '/bin/zsh',
                    env: { ...process.env, NODE_OPTIONS: '' },
                });
                return { content: [{ type: 'text', text: output.trim() || 'No type errors found.' }], isError: false };
            } catch (execError: any) {
                const output = execError.stdout || execError.stderr || String(execError);
                // tsc returns exit code 2 when there are type errors — not a tool error
                if (execError.status === 2 || execError.status === 1) {
                    return { content: [{ type: 'text', text: `Type errors found:\n${output}` }], isError: false };
                }
                return { content: [{ type: 'text', text: `tsc execution error:\n${output}` }], isError: true };
            }
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('git_diff_summary', {
        description: 'Show git diff summary for a project. Returns changed files with stats (insertions/deletions) and recent commit log. Useful for supervisor to evaluate code contributions that are invisible in CC logs. Available to supervisor/help-agent/org-manager.',
        title: 'Git Diff Summary',
        inputSchema: {
            path: z.string().describe('Git repository path (e.g. /Users/swmt/happy0313/aha-cli)'),
            since: z.string().optional().describe('Show changes since this ref or time (e.g. "HEAD~5", "2 hours ago"). Default: HEAD~10'),
            author: z.string().optional().describe('Filter commits by author name pattern'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent' && role !== 'org-manager') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager can use git_diff_summary.' }], isError: true };
        }
        try {
            const { execSync } = await import('node:child_process');
            const fs = await import('node:fs');

            if (!fs.existsSync(args.path)) {
                return { content: [{ type: 'text', text: `Directory not found: ${args.path}` }], isError: true };
            }

            const since = args.since || 'HEAD~10';
            const authorFilter = args.author ? `--author="${args.author}"` : '';

            // Collect: commit log + diff stat
            const logCmd = `git log --oneline --no-decorate ${authorFilter} ${since}..HEAD 2>/dev/null | head -30`;
            const diffCmd = `git diff --stat ${since} 2>/dev/null | tail -30`;
            const statusCmd = `git status --short 2>/dev/null | head -30`;

            const log = execSync(logCmd, { cwd: args.path, encoding: 'utf-8', shell: '/bin/zsh', timeout: 10_000 }).trim();
            const diff = execSync(diffCmd, { cwd: args.path, encoding: 'utf-8', shell: '/bin/zsh', timeout: 10_000 }).trim();
            const status = execSync(statusCmd, { cwd: args.path, encoding: 'utf-8', shell: '/bin/zsh', timeout: 10_000 }).trim();

            const lines = [];
            if (log) {
                lines.push('=== Recent Commits ===', log);
            } else {
                lines.push('=== Recent Commits ===', '(no commits in range)');
            }
            if (diff) {
                lines.push('', '=== Diff Stats ===', diff);
            }
            if (status) {
                lines.push('', '=== Uncommitted Changes ===', status);
            }

            return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('read_unified_log', {
        description: 'Aggregate team messages, supervisor scores, help requests, and trace events into a single time-ordered stream. Use this for fast cross-source debugging without manually calling multiple log tools. Supervisor/help-agent only.',
        title: 'Read Unified Log',
        inputSchema: {
            teamId: z.string().describe('Team ID to read unified log for'),
            limit: z.number().default(200).describe('Max total entries across all sources'),
            fromTs: z.number().default(0).describe('Unix ms timestamp to start from. 0 = all time.'),
            sources: z.array(z.enum(['team', 'supervisor', 'help', 'trace'])).default(['team', 'supervisor', 'help']).describe('Log sources to include. trace queries trace.db and is slower.'),
            roles: z.array(z.string()).optional().describe('Optional role filter for team message entries'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (role !== 'supervisor' && role !== 'help-agent') {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent can read unified logs.' }], isError: true };
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(args.teamId)) {
            return { content: [{ type: 'text', text: 'Error: Invalid teamId format.' }], isError: true };
        }

        try {
            const { readUnifiedLog } = await import('@/claude/utils/unifiedLogReader');
            const result = readUnifiedLog({
                teamId: args.teamId,
                cwd: process.cwd(),
                ahaHomeDir: configuration.ahaHomeDir,
                limit: args.limit,
                fromTs: args.fromTs,
                sources: args.sources as Array<'team' | 'supervisor' | 'help' | 'trace'>,
                roles: args.roles,
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error reading unified log: ${String(error)}` }], isError: true };
        }
    });
}
