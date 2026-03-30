import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
/**
 * @module agentTools
 * @description MCP tool registrations for agent spawning and management.
 *
 * ```mermaid
 * graph LR
 *   A[agentTools] -->|ctx.mcp| B[McpServer]
 *   A -->|ctx.api| C[ApiClient]
 *   A -->|ctx.client| D[ApiSessionClient]
 *   A -->|ctx.spawnReplacementSession| E[spawnHelper]
 *   A -->|ctx.evaluateReplacementVotes| F[voteHelper]
 *   A -->|ctx.getDaemonTrackedSessionIds| G[daemonHelper]
 * ```
 *
 * ## Tools registered
 * - list_available_agents, create_agent, list_team_agents
 * - update_agent_model, evaluate_replacement_votes, replace_agent
 *
 * ## Design
 * - All tools share McpToolContext (see mcpContext.ts)
 * - Agent spawning delegates to the daemon /spawn-session endpoint
 * - Replacement logic uses spawnReplacementSession helper from mcpContext
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { DEFAULT_ROLES } from '@/claude/team/roles.config';
import { canSpawnAgents, BYPASS_ROLES } from '@/claude/team/roles';
import { createTeamMemberIdentity } from '../utils/teamMemberIdentity';
import { projectTeamAgentMirror } from '../utils/runEnvelopeMirror';
import { readDaemonState } from '@/persistence';
import { extractTeamConfigSnapshot } from './inspectionTools';
import {
    publishTeamCorpsTemplate,
    resolvePreferredGenomeSpecId,
    searchMarketplaceGenomes,
} from '@/utils/genomeMarketplace';
import { emitTraceEvent } from '@/trace/traceEmitter';
import { TraceEventKind } from '@/trace/traceTypes';
import { McpToolContext, ReplaceAgentStageError } from './mcpContext';

export function registerAgentTools(ctx: McpToolContext): void {
    const {
        mcp,
        api,
        client,
        genomeSpecRef,
        getCurrentTeamMemberContext,
        getDaemonTrackedSessionIds,
        getTeamMemberRecord,
        evaluateReplacementVotes,
        parseBoardFromArtifact,
        spawnReplacementSession,
    } = ctx;

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
        const allowed = canSpawnAgents(role, effectiveGenome);
        if (!allowed) {
            return { content: [{ type: 'text', text: 'Error: Your genome/role does not have permission to browse the agent marketplace.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
        try {
            const includeCorps = args.category === 'corps';
            const marketplaceEntries = (await searchMarketplaceGenomes({
                query: args.query,
                category: args.category,
                limit: args.limit ?? 100,
                hubUrl,
            }))
                .filter(g => includeCorps || g.category !== 'corps')
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

            if (marketplaceEntries.length === 0) {
                const noun = includeCorps ? 'team templates' : 'agents';
                return { content: [{ type: 'text', text: args.query ? `No marketplace ${noun} matched "${args.query}".` : 'Marketplace is empty.' }], isError: false };
            }

            // Compact directory: one line per genome, minimal tokens
            const lines = marketplaceEntries.map(g => {
                let fb: { avgScore?: number; evaluationCount?: number } = {};
                try {
                    fb = g.feedbackData ? JSON.parse(g.feedbackData) : {};
                } catch (error) {
                    if (process.env.NODE_ENV === 'development') {
                        logger.error(`[DEV] Malformed feedbackData for genome ${g.id}:`, error);
                        throw new Error(`Genome feedbackData is malformed - DB integrity issue: ${String(error)}`);
                    }
                    logger.error(`[PROD] Malformed feedbackData for genome ${g.id}, using empty object`, error);
                    fb = {};
                }
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

            const header = includeCorps
                ? `${marketplaceEntries.length} team templates (category=corps). Use the returned ids/refs in template-based team creation flows.${args.query ? ` Query="${args.query}".` : ''}`
                : `${marketplaceEntries.length} agents (sorted by score). Pass id to create_agent(specId=...) to spawn.${args.query ? ` Query="${args.query}".` : ''}`;
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

            // Centralize spawn permission logic in canSpawnAgents() so legacy
            // compatibility shims and explicit authorities stay consistent.
            const allowed = canSpawnAgents(role, effectiveGenome);
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
                const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
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
                            ...(resolvedSpecId ? { candidateId: `spec:${resolvedSpecId}` } : {}),
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
        description: 'List all agents currently in the team, including their roles, session IDs, status, runtime metadata, and assigned-task summary.',
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
            const tasksResult = await api.listTasks(teamId).catch(() => ({ tasks: [], version: 0 }));
            const tasks = Array.isArray(tasksResult.tasks) ? tasksResult.tasks : [];
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
                const assigneeId = typeof task?.assigneeId === 'string' ? task.assigneeId : null;
                if (!assigneeId) continue;

                const status = String(task?.status || 'todo');
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
            const envelopeEntries = await Promise.all(
                Array.from(allSessionIds).map(async (sessionId: string) => {
                    try {
                        const { readRunEnvelope } = await import('@/daemon/runEnvelope');
                        return [sessionId, await readRunEnvelope(sessionId)] as const;
                    } catch {
                        return [sessionId, null] as const;
                    }
                })
            );
            const envelopeMap = new Map(envelopeEntries);

            // Role definitions — from DEFAULT_ROLES fallback (genome is primary)
            const roleDefinitions: Record<string, any> = {};
            for (const [id, def] of Object.entries(DEFAULT_ROLES)) {
                roleDefinitions[id] = { title: def.name };
            }

            const agents = Array.from(allSessionIds).flatMap((sessionId: string) => {
                const member = memberMap.get(sessionId) as Record<string, any> | undefined;
                const sessionSnapshot = sessionSnapshotMap.get(sessionId);
                const envelope = envelopeMap.get(sessionId);
                const lifecycleState = sessionSnapshot?.metadata?.lifecycleState;
                const isActive = daemonTrackedSessionIds.has(sessionId)
                    || !!(sessionSnapshot && sessionSnapshot.active !== false && lifecycleState !== 'archived');

                if (!isActive) {
                    return [];
                }

                const roleId = member?.roleId || member?.role || '';
                const roleDef = roleDefinitions[roleId];
                const projectedMirror = projectTeamAgentMirror({
                    sessionId,
                    member,
                    sessionSnapshot,
                    envelope,
                    defaultExecutionPlane: BYPASS_ROLES.includes(roleId) ? 'bypass' : 'mainline',
                    defaultRuntimeType: 'claude',
                });
                return [{
                    sessionId,
                    role: roleDef?.title || roleId || 'unknown',
                    roleId,
                    displayName: member?.displayName || sessionId?.substring(0, 8),
                    candidateId: projectedMirror.candidateId,
                    specId: projectedMirror.specId,
                    memberId: projectedMirror.memberId,
                    runId: projectedMirror.runId,
                    runStatus: projectedMirror.runStatus,
                    spawnedAt: projectedMirror.spawnedAt,
                    executionPlane: projectedMirror.executionPlane,
                    runtimeType: projectedMirror.runtimeType,
                    lifecycleState: lifecycleState || 'running',
                    taskStats: taskStatsByAssignee.get(sessionId) ?? {
                        total: 0,
                        todo: 0,
                        inProgress: 0,
                        review: 0,
                        done: 0,
                        blocked: 0,
                        taskIds: [],
                    },
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

    mcp.registerTool('update_agent_model', {
        description: 'Override the model for a running agent session. Supervisor/master can use this to switch any agent\'s model. Takes effect the next time the agent session is started/restarted.',
        title: 'Update Agent Model',
        inputSchema: {
            sessionId: z.string().describe('Session ID of the agent to update'),
            modelId: z.string().describe('New model to use (e.g. claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-6)'),
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

    mcp.registerTool('get_team_config', {
        description: 'Inspect the current team template/config at runtime. Returns team name, roles, agreements, and boot context. Available to all mainline agents.',
        title: 'Get Team Config',
        inputSchema: {
            teamId: z.string().optional().describe('Optional team ID. Defaults to your current team.'),
        },
    }, async (args) => {
        const metadata = client.getMetadata();
        const executionPlane = metadata?.executionPlane || 'mainline';
        if (executionPlane !== 'mainline') {
            return { content: [{ type: 'text', text: 'Error: get_team_config is only available to mainline agents.' }], isError: true };
        }

        const teamId = args.teamId || metadata?.teamId || metadata?.roomId;
        if (!teamId) {
            return { content: [{ type: 'text', text: 'Error: You must be in a team or provide teamId.' }], isError: true };
        }

        try {
            const artifact = await api.getArtifact(teamId);
            const board = parseBoardFromArtifact(artifact);
            const snapshot = extractTeamConfigSnapshot(teamId, board);
            return {
                content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error getting team config: ${String(error)}` }], isError: true };
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
            let targetSession: any | null = null;
            try {
                targetSession = await api.getSession(args.sessionId);
            } catch (error) {
                throw new ReplaceAgentStageError(
                    'lookup.target_session',
                    error instanceof Error ? error.message : String(error),
                    {
                        sessionId: args.sessionId,
                        teamHint: args.teamId || metadata?.teamId || metadata?.roomId || null,
                    },
                    'Verify the session API is reachable before attempting replacement.',
                );
            }
            if (!targetSession) {
                return { content: [{ type: 'text', text: `Error: Session ${args.sessionId} not found.` }], isError: true };
            }

            const inferredTeamId = args.teamId || metadata?.teamId || metadata?.roomId || targetSession.metadata?.teamId || targetSession.metadata?.roomId;
            if (!inferredTeamId) {
                throw new ReplaceAgentStageError(
                    'lookup.team',
                    'Could not determine team for replacement.',
                    { sessionId: args.sessionId },
                    'Provide teamId explicitly or ensure the session metadata includes teamId/roomId.',
                );
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
                directory: targetSession.metadata?.path || metadata?.path || process.cwd(),
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
                try {
                    const tasksResult = await api.listTasks(inferredTeamId, { assigneeId: args.sessionId });
                    const tasks = Array.isArray(tasksResult?.tasks) ? tasksResult.tasks : [];
                    for (const task of tasks) {
                        if (task?.status === 'done') continue;
                        await api.updateTask(inferredTeamId, task.id, {
                            assigneeId: replacement.sessionId,
                            comment: {
                                sessionId: client.sessionId,
                                role: callerRole,
                                type: 'handoff',
                                content: `Reassigned from ${args.sessionId} to ${replacement.sessionId}. Reason: ${args.reason}`,
                                mentions: [replacement.sessionId],
                            },
                        });
                        reassignedTasks += 1;
                    }
                } catch (error) {
                    throw new ReplaceAgentStageError(
                        'reassign.tasks',
                        error instanceof Error ? error.message : String(error),
                        {
                            teamId: inferredTeamId,
                            oldSessionId: args.sessionId,
                            newSessionId: replacement.sessionId,
                        },
                        'Verify task APIs are healthy before retrying task reassignment.',
                    );
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
            if (error instanceof ReplaceAgentStageError) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: {
                                stage: error.stage,
                                message: error.message,
                                details: error.details,
                                remediation: error.remediation ?? null,
                            },
                        }, null, 2),
                    }],
                    isError: true,
                };
            }
            const msg = error instanceof Error ? error.message : String(error);
            const hint = msg === 'fetch failed' ? ' (replace_agent failed before stage attribution; inspect server/daemon reachability)' : '';
            return { content: [{ type: 'text', text: `Error replacing agent: ${msg}${hint}` }], isError: true };
        }
    });
}
