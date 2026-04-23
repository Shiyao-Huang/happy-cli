import { DEFAULT_GENOME_HUB_URL, readPublishKeyFromSettings, resolveAhaHomeDir } from '@/configurationResolver'
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
 *   A -->|ctx.genomeSpecRef| E[AgentImage]
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
 *   get_effective_permissions, get_host_health
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
import type { DiffChange, AgentPlugRecord, AgentVerdict, AgentImage, DiffLedgerEntry } from '@/api/types/genome';
import { writeScore, readScores } from '@/claude/utils/scoreStorage';
import { aggregateScores } from '@/claude/utils/feedbackPrivacy';
import { resolveFeedbackUploadTarget, scoreMatchesFeedbackTarget, deriveFeedbackTargetFromScores } from '../utils/supervisorAgentVerdict';
import { syncGenomeFeedbackToMarketplace } from '../utils/genomeFeedbackSync';
import { buildSessionScopeFilters, matchesSessionScopeFilter } from '@/claude/team/sessionScope';
import { stripSessionScopedAhaEnv } from '@/utils/sessionScopedAhaEnv';

function canUseSupervisorObservationTools(role?: string): boolean {
    return typeof role === 'string'
        && (SUPERVISOR_OBSERVATION_ROLES as readonly string[]).includes(role);
}
import { projectSelfMirrorIdentity } from '../utils/runEnvelopeMirror';
import { readRuntimeLog, resolveTeamRuntimeLogs } from '../utils/runtimeLogReader';
import { getContextStatusReport } from '../utils/contextStatus';
import { fetchAgentImage, fetchAgentPackage } from '../utils/fetchGenome';
import { emitTraceEvent, emitTraceLink } from '@/trace/traceEmitter';
import { TraceEventKind } from '@/trace/traceTypes';
import { readDaemonState } from '@/persistence';
import { restartDaemonFlow } from '@/daemon/restartDaemon';
import { formatHostHealth, getHostHealth } from '@/daemon/hostHealth';
import { registerResourceGovernorTools } from '@/governance/mcpResourceTools';
import { getResourceGovernor } from '@/governance/resourceGovernor';
import { generateRolePrompt } from '@/claude/team/roles';
import {
    INSPECT_PRIVILEGED_ROLES,
    SCORING_ROLES,
    GENOME_EDIT_ROLES,
    TOOL_GRANT_ROLES,
    AGENT_REPLACE_ROLES,
    SUPERVISOR_OBSERVATION_ROLES,
} from '@/claude/team/roleConstants';

import {
    buildEffectivePermissionsReport,
    buildRuntimePermissionSnapshot,
    canInspectGenomeSpec,
    explainRuntimeToolAccess,
    type RuntimePermissionSnapshot,
} from './inspectionTools';
import { McpToolContext } from './mcpContext';
import { buildMountedAgentPrompt } from '@/utils/buildMountedAgentPrompt';
import type { Metadata } from '@/api/types';

/**
 * Resolve entity namespace + name from explicit params or a specRef string.
 * specRef format: "@namespace/name" or "@namespace/name:version"
 */
export function resolveEntityNsName(
    specNamespace: string | undefined,
    specName: string | undefined,
    specRef: string | undefined,
): { ns: string; name: string } | null {
    if (specNamespace && specName) return { ns: specNamespace, name: specName };
    if (!specRef) return null;
    const match = specRef.match(/^@?([^/]+)\/([^:]+)/);
    if (!match) return null;
    return { ns: `@${match[1]}`, name: match[2] };
}

/**
 * Build the verdict content string from scoring dimensions and metadata.
 */
export function buildVerdictContent(args: {
    role: string;
    sessionId: string;
    overall: number;
    action: string;
    dimensions: {
        delivery: number;
        integrity: number;
        efficiency: number;
        collaboration: number;
        reliability: number;
    };
    recommendations?: string[];
}): string {
    return [
        `Role: ${args.role}, Session: ${args.sessionId}`,
        `Overall: ${args.overall}/100, Action: ${args.action}`,
        `Dimensions: delivery=${args.dimensions.delivery} integrity=${args.dimensions.integrity} efficiency=${args.dimensions.efficiency} collaboration=${args.dimensions.collaboration} reliability=${args.dimensions.reliability}`,
        args.recommendations?.length ? `Recommendations: ${args.recommendations.join('; ')}` : '',
    ].filter(Boolean).join('\n');
}

export function buildVisibleToolsPayload(args: {
    sessionId: string;
    snapshot: RuntimePermissionSnapshot;
    cursor?: number;
    limit?: number;
    includeAll?: boolean;
}): {
    sessionId: string;
    total: number | null;
    cursor: number;
    limit: number;
    nextCursor: number | null;
    includeAll: boolean;
    visibleInventoryKnown: boolean;
    tools: RuntimePermissionSnapshot['visibleEntries'] | null;
    warnings: string[];
} {
    const includeAll = args.includeAll ?? true;
    const cursor = args.cursor ?? 0;
    const limit = args.limit ?? 50;

    if (!args.snapshot.visibleInventoryKnown) {
        return {
            sessionId: args.sessionId,
            total: null,
            cursor,
            limit,
            nextCursor: null,
            includeAll,
            visibleInventoryKnown: false,
            tools: null,
            warnings: args.snapshot.warnings,
        };
    }

    let entries = [...args.snapshot.visibleEntries];
    if (!includeAll) {
        entries = entries.filter((entry) => entry.rawName.startsWith('mcp__aha__'));
    }

    const page = entries.slice(cursor, cursor + limit);

    return {
        sessionId: args.sessionId,
        total: entries.length,
        cursor,
        limit,
        nextCursor: cursor + page.length < entries.length ? cursor + page.length : null,
        includeAll,
        visibleInventoryKnown: true,
        tools: page,
        warnings: args.snapshot.warnings,
    };
}

export type RetireHandoffTaskApi = {
    listTasks(
        teamId: string,
        filters?: { status?: string; assigneeId?: string },
    ): Promise<{ tasks: Array<{ id: string }>; version?: number }>;
    addTaskComment(
        teamId: string,
        taskId: string,
        comment: {
            sessionId: string;
            role?: string;
            displayName?: string;
            type?: 'handoff';
            content: string;
        },
    ): Promise<unknown>;
};

export async function writeRetireHandoffTaskComments(args: {
    api: RetireHandoffTaskApi;
    teamId?: string | null;
    sessionId: string;
    role?: string;
    displayName?: string;
    handoffNote: string;
}): Promise<string[]> {
    if (!args.teamId) return [];

    try {
        const { tasks } = await args.api.listTasks(args.teamId, {
            assigneeId: args.sessionId,
            status: 'in-progress',
        });

        const handoffTaskIds: string[] = [];
        for (const task of tasks) {
            if (!task?.id) continue;
            try {
                await args.api.addTaskComment(args.teamId, task.id, {
                    sessionId: args.sessionId,
                    role: args.role,
                    displayName: args.displayName,
                    type: 'handoff',
                    content: args.handoffNote,
                });
                handoffTaskIds.push(task.id);
            } catch {
                // Best-effort per task: continue with the remaining in-progress tasks.
            }
        }

        return handoffTaskIds;
    } catch {
        // Best-effort: retire_self should not fail just because task comment persistence failed.
        return [];
    }
}

export async function registerSupervisorTools(ctx: McpToolContext): Promise<void> {
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
        metadata: Metadata | null;
        genomeSpec: import('@/api/types/genome').AgentImage | null;
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
        const metadata = (isSelf ? requesterMetadata : targetSession?.metadata) as Metadata | null | undefined;

        let genomeSpec = isSelf ? (genomeSpecRef?.current ?? null) : null;
        if (!genomeSpec && specId) {
            genomeSpec = await fetchAgentImage(client.getAuthToken(), specId).catch(() => null);
        }

        return {
            sessionId,
            teamId,
            role,
            specId,
            metadata: metadata ?? null,
            genomeSpec,
            memberAuthorities: Array.isArray(member?.authorities) ? member.authorities : [],
            teamOverlayAuthorities: Array.isArray(member?.teamOverlay?.authorities) ? member.teamOverlay.authorities : [],
        };
    };

    const canInspectOtherSession = (requestedSessionId?: string): { requestedSessionId: string; isSelf: boolean; callerRole: string | undefined; error?: string } => {
        const callerRole = client.getMetadata()?.role;
        const resolvedSessionId = requestedSessionId || client.sessionId;
        const isSelf = resolvedSessionId === client.sessionId;

        if (!isSelf && (!callerRole || !(INSPECT_PRIVILEGED_ROLES as readonly string[]).includes(callerRole))) {
            return {
                requestedSessionId: resolvedSessionId,
                isSelf,
                callerRole,
                error: `Role '${callerRole}' cannot inspect other sessions.`,
            };
        }

        return {
            requestedSessionId: resolvedSessionId,
            isSelf,
            callerRole,
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

    const resolveEntityMirrorUrl = (specId: string): string => {
        const base = (process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
        const nsMatch = specId.match(/^(@[^/]+)\/([^:]+)(?::(\d+))?$/);
        if (nsMatch) {
            const [, ns, name, version] = nsMatch;
            const encodedNs = encodeURIComponent(ns);
            return version
                ? `${base}/entities/${encodedNs}/${name}/${version}`
                : `${base}/entities/${encodedNs}/${name}`;
        }
        return `${base}/entities/id/${encodeURIComponent(specId)}`;
    };

    type MarketplaceAgentVerdict = Pick<AgentVerdict, 'evaluationCount' | 'avgScore' | 'dimensions' | 'latestAction' | 'updatedAt'>;

    const parseFeedbackData = (feedbackData?: string | null): MarketplaceAgentVerdict | null => {
        if (!feedbackData) return null;
        try {
            return JSON.parse(feedbackData) as MarketplaceAgentVerdict;
        } catch {
            return null;
        }
    };

    const normalizeMirrorJson = (value: unknown): unknown => {
        if (Array.isArray(value)) {
            return value.map((entry) => normalizeMirrorJson(entry));
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, nested]) => [key, normalizeMirrorJson(nested)]),
            );
        }
        return value;
    };

    const mirrorJsonEquals = (left: unknown, right: unknown): boolean => (
        JSON.stringify(normalizeMirrorJson(left)) === JSON.stringify(normalizeMirrorJson(right))
    );

    const collectChangedTopLevelManifestOps = (
        currentSpec: Record<string, unknown>,
        nextSpec: Record<string, unknown>,
    ): Array<{ type: 'manifest_set'; path: string; value: unknown }> => {
        const changedKeys = new Set([
            ...Object.keys(currentSpec),
            ...Object.keys(nextSpec),
        ]);

        return Array.from(changedKeys)
            .filter((key) => !mirrorJsonEquals(currentSpec[key], nextSpec[key]))
            .filter((key) => nextSpec[key] !== undefined)
            .map((key) => ({
                type: 'manifest_set' as const,
                path: key,
                value: nextSpec[key],
            }));
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

    type EntityMirrorRecord = {
        id: string;
        kind?: 'agent' | 'legion' | null;
        namespace?: string | null;
        name: string;
        version: number;
        spec: string;
        seed?: string | null;
        feedbackData?: string | null;
        description?: string | null;
        tags?: string | null;
        category?: string | null;
    };

    type EntityDiffRecord = {
        id: string;
        entityId: string;
        version: number;
        description: string;
        verdictRefs?: string[] | null;
        changes: DiffChange[];
        strategy?: string | null;
        authorRole?: string | null;
        authorSession?: string | null;
        createdAt: string;
    };

    const fetchEntityMirror = async (specId: string): Promise<{
        entity: EntityMirrorRecord;
        spec: Record<string, unknown>;
        seedSpec: Record<string, unknown> | null;
        diffHistory: EntityDiffRecord[];
        ledgerEntries: DiffLedgerEntry[];
        replayedSpec: Record<string, unknown> | null;
        replayMatchesView: boolean | null;
    }> => {
        const entityRes = await fetch(resolveEntityMirrorUrl(specId), { signal: AbortSignal.timeout(5_000) });
        if (!entityRes.ok) {
            throw new Error(`Failed to fetch entity mirror for ${specId}: HTTP ${entityRes.status}`);
        }
        const entityData = await entityRes.json() as { entity?: EntityMirrorRecord };
        if (!entityData.entity) {
            throw new Error(`Entity mirror for ${specId} was missing payload.`);
        }

        const entity = entityData.entity;
        const spec = JSON.parse(entity.spec) as Record<string, unknown>;
        const seedSpec = entity.seed ? JSON.parse(entity.seed) as Record<string, unknown> : null;

        let diffHistory: EntityDiffRecord[] = [];
        let ledgerEntries: DiffLedgerEntry[] = [];
        let replayedSpec: Record<string, unknown> | null = null;
        let replayMatchesView: boolean | null = null;
        if (entity.namespace && entity.name) {
            const hubBaseUrl = (process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
            const encodedNs = encodeURIComponent(entity.namespace);
            const encodedName = encodeURIComponent(entity.name);
            const ledgerParams = new URLSearchParams();
            if (Number.isInteger(entity.version) && entity.version > 0) {
                ledgerParams.set('version', String(entity.version));
            }

            const [diffRes, ledgerRes] = await Promise.all([
                fetch(
                    `${hubBaseUrl}/entities/${encodedNs}/${encodedName}/diffs`,
                    { signal: AbortSignal.timeout(5_000) },
                ),
                fetch(
                    `${hubBaseUrl}/genomes/${encodedNs}/${encodedName}/ledger${ledgerParams.size > 0 ? `?${ledgerParams.toString()}` : ''}`,
                    { signal: AbortSignal.timeout(5_000) },
                ),
            ]);
            if (!diffRes.ok) {
                throw new Error(`Failed to fetch entity diff history for ${entity.namespace}/${entity.name}: HTTP ${diffRes.status}`);
            }
            if (!ledgerRes.ok) {
                throw new Error(`Failed to fetch canonical ledger for ${entity.namespace}/${entity.name}: HTTP ${ledgerRes.status}`);
            }

            const diffData = await diffRes.json() as { diffs?: EntityDiffRecord[] };
            if (!Array.isArray(diffData.diffs)) {
                throw new Error(`Entity diff history for ${entity.namespace}/${entity.name} was malformed.`);
            }
            diffHistory = diffData.diffs;

            const ledgerData = await ledgerRes.json() as { ledger?: DiffLedgerEntry[]; replayedSpec?: string | null };
            if (!Array.isArray(ledgerData.ledger)) {
                throw new Error(`Canonical ledger for ${entity.namespace}/${entity.name} was malformed.`);
            }
            ledgerEntries = ledgerData.ledger;

            if (typeof ledgerData.replayedSpec === 'string' && ledgerData.replayedSpec.trim().length > 0) {
                const parsedReplay = JSON.parse(ledgerData.replayedSpec);
                if (parsedReplay === null || typeof parsedReplay !== 'object' || Array.isArray(parsedReplay)) {
                    throw new Error(`Canonical replay for ${entity.namespace}/${entity.name} was not a JSON object.`);
                }
                replayedSpec = parsedReplay as Record<string, unknown>;
                replayMatchesView = mirrorJsonEquals(spec, replayedSpec);
            }
        }

        return { entity, spec, seedSpec, diffHistory, ledgerEntries, replayedSpec, replayMatchesView };
    };

    const fetchGenomeDiffs = async (hubUrl: string, namespace: string, name: string): Promise<AgentPlugRecord[]> => {
        const res = await fetch(
            `${hubUrl}/genomes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/diffs`,
            { signal: AbortSignal.timeout(5_000) }
        );
        if (!res.ok) {
            throw new Error(`Failed to fetch diffs: HTTP ${res.status}`);
        }
        const data = await res.json() as { diffs?: AgentPlugRecord[] };
        return Array.isArray(data.diffs) ? data.diffs : [];
    };

    const parseDiffChanges = (changes?: string | null): DiffChange[] => {
        if (!changes) return [];
        try {
            const parsed = JSON.parse(changes) as DiffChange[];
            if (!Array.isArray(parsed)) {
                throw new Error('Diff change payload was not an array.');
            }
            return parsed;
        } catch {
            throw new Error('Failed to parse diff change payload.');
        }
    };

    const applyPreviewStringDiff = (
        spec: Record<string, unknown>,
        path: string,
        op: 'append' | 'replace' | 'remove',
        content: string,
    ): Record<string, unknown> => {
        const segments = path.split('.');
        const parentPath = segments.slice(0, -1).join('.');
        const field = segments[segments.length - 1];

        const getAtPath = (obj: Record<string, unknown>, dotPath: string): unknown => {
            if (!dotPath) return obj;
            return dotPath.split('.').reduce<unknown>((cur, key) => {
                if (cur != null && typeof cur === 'object' && !Array.isArray(cur)) {
                    return (cur as Record<string, unknown>)[key];
                }
                return undefined;
            }, obj);
        };

        const parentObj = parentPath
            ? (getAtPath(spec, parentPath) as Record<string, unknown> ?? {})
            : spec;

        const current = parentObj[field];
        let newValue: unknown = current;

        if (op === 'append') {
            if (Array.isArray(current)) {
                newValue = [...current, content];
            } else if (typeof current === 'string') {
                newValue = current ? `${current}\n${content}` : content;
            } else {
                newValue = [content];
            }
        } else if (op === 'replace') {
            newValue = content;
        } else if (op === 'remove') {
            if (Array.isArray(current)) {
                newValue = current.filter((item: unknown) => item !== content);
            } else if (typeof current === 'string') {
                newValue = current.split(content).join('');
            }
        }

        if (parentPath) {
            const newParent = { ...parentObj, [field]: newValue };
            return applyKvDiff(spec, parentPath, newParent);
        }
        return { ...spec, [field]: newValue };
    };

    const applyPreviewDiffChanges = (
        spec: Record<string, unknown>,
        changes: DiffChange[],
    ): Record<string, unknown> => {
        let result = { ...spec };
        for (const change of changes) {
            switch (change.type) {
                case 'kv':
                    result = applyKvDiff(result, change.path, change.to);
                    break;
                case 'string':
                    result = applyPreviewStringDiff(result, change.path, change.op, change.content);
                    break;
                case 'narrative':
                    break;
            }
        }
        return result;
    };

    mcp.registerTool('read_team_log', {
        description: 'Read the team message log. Returns messages since the last supervisor run (cursor-based, incremental). Pass fromCursor=0 to read all. Supervisor/help-agent only.',
        title: 'Read Team Log',
        inputSchema: {
            teamId: z.string().describe('Team ID to read logs for'),
            limit: z.coerce.number().default(100).describe('Max messages to return'),
            fromCursor: z.coerce.number().default(-1).describe('Line index to read from. -1 = use env AHA_SUPERVISOR_TEAM_LOG_CURSOR (auto-incremental). 0 = read all.'),
            scopePath: z.string().optional().describe('Optional explicit scope path. Defaults to the current session scope when available.'),
            repoName: z.string().optional().describe('Optional explicit repo family filter. Defaults to the current session repo when available.'),
            includeGlobal: z.boolean().optional().describe('Include global or unscoped messages alongside scoped ones. Defaults to true when scope filtering is active.'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (!canUseSupervisorObservationTools(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager/master can read team logs.' }], isError: true };
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(args.teamId)) {
            return { content: [{ type: 'text', text: 'Error: Invalid teamId format.' }], isError: true };
        }
        try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const localPath = path.join(process.cwd(), '.aha', 'teams', args.teamId, 'messages.jsonl');
            const scopeFilters = {
                ...buildSessionScopeFilters(client.getMetadata()),
                ...(args.scopePath ? { scopePath: args.scopePath } : {}),
                ...(args.repoName ? { repoName: args.repoName } : {}),
                ...(args.includeGlobal !== undefined ? { includeGlobal: args.includeGlobal } : {}),
            };

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

                        const serverResult = await api.getTeamMessages(args.teamId, { limit: args.limit, ...scopeFilters });
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
                            messages: newLines
                                .map(l => { try { return JSON.parse(l); } catch { return l; } })
                                .filter((message) => matchesSessionScopeFilter((message as any)?.metadata?.scope, scopeFilters)),
                        }, null, 2)
                    }],
                    isError: false
                };
            }
            const messages = await api.getTeamMessages(args.teamId, { limit: args.limit, ...scopeFilters });
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
            const requesterMetadata = client.getMetadata();
            let targetMetadata = requesterMetadata;
            let targetAhaSessionId = client.sessionId;
            let requestedSessionId = args.sessionId;

            if (args.sessionId) {
                const targetSession = args.sessionId === client.sessionId
                    ? null
                    : await api.getSession(args.sessionId).catch(() => null);
                if (targetSession?.metadata) {
                    targetMetadata = targetSession.metadata;
                    targetAhaSessionId = targetSession.id || args.sessionId;
                } else {
                    targetAhaSessionId = args.sessionId;
                }

                const teamId = targetMetadata?.teamId
                    || targetMetadata?.roomId
                    || requesterMetadata?.teamId
                    || requesterMetadata?.roomId;
                if (teamId) {
                    const daemonState = await readDaemonState().catch(() => null);
                    if (daemonState?.httpPort) {
                        const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/list-team-sessions`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ teamId }),
                            signal: AbortSignal.timeout(5_000),
                        }).catch(() => null);
                        if (response?.ok) {
                            const result = await response.json() as {
                                sessions?: Array<{
                                    ahaSessionId: string;
                                    claudeLocalSessionId?: string;
                                    runtimeType?: string;
                                    role?: string;
                                }>;
                            };
                            const match = result.sessions?.find((session) =>
                                session.ahaSessionId === args.sessionId ||
                                session.claudeLocalSessionId === args.sessionId
                            );
                            if (match) {
                                targetAhaSessionId = match.ahaSessionId;
                                requestedSessionId = match.runtimeType === 'claude'
                                    ? (match.claudeLocalSessionId || match.ahaSessionId)
                                    : match.ahaSessionId;
                                targetMetadata = {
                                    ...(targetMetadata || {}),
                                    ...(match.runtimeType ? { flavor: match.runtimeType as any } : {}),
                                    ...(match.role ? { role: match.role } : {}),
                                    ...(match.claudeLocalSessionId ? { claudeSessionId: match.claudeLocalSessionId } : {}),
                                };
                            }
                        }
                    }
                }
            }

            const report = getContextStatusReport({
                homeDir: process.env.HOME || '/tmp',
                metadata: targetMetadata,
                ahaSessionId: targetAhaSessionId,
                requestedSessionId,
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

    // ─── get_host_health ──────────────────────────────────────────────────────
    // All agents can call this before heavy operations to inspect current machine health.
    mcp.registerTool('get_host_health', {
        description: [
            'Inspect current host-machine health before running heavy operations.',
            'Returns free memory, disk space, load average, active agent count, and alert messages.',
            'Call this before build, full typecheck, full test, or other high-memory work.',
            'Available to ALL team members.',
        ].join(' '),
        title: 'Get Host Health',
        inputSchema: {
            format: z.enum(['text', 'json']).optional().describe('Response format. Defaults to text.'),
        },
    }, async (args) => {
        try {
            const trackedSessions = await getDaemonTrackedSessionIds().catch(() => new Set<string>());
            const report = getHostHealth(trackedSessions.size, configuration.ahaHomeDir);

            if (args.format === 'json') {
                return {
                    content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
                    isError: false,
                };
            }

            const alertSuffix = report.alerts.length > 0
                ? `\n\nAlerts:\n- ${report.alerts.join('\n- ')}`
                : '\n\nAlerts:\n- none';

            return {
                content: [{
                    type: 'text',
                    text: `${formatHostHealth(report)}${alertSuffix}`,
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error getting host health: ${String(error)}` }], isError: true };
        }
    });

    // ─── Resource Governor tools ──────────────────────────────────────────────
    registerResourceGovernorTools(mcp, {
        ahaHomeDir: configuration.ahaHomeDir,
        activeAgentCount: (await getDaemonTrackedSessionIds().catch(() => new Set<string>())).size,
    });

    // ─── get_self_view — the mirror ────────────────────────────────────────────
    // Combines identity, context, team pulse, and genome into one self-awareness snapshot.
    mcp.registerTool('get_self_view', {
        description: [
            'See yourself: who you are, your context usage, your team, and your performance.',
            'Combines identity (role, AgentImage/genome), capabilities, behavior config, context window status, team pulse, tasks, and performance into one view.',
            'Also returns the effective prompt mirror, current materialized AgentImage (view), AgentPlug history (view-diff), canonical ledger rows (view-ledger), and seed spec (view-not-diff) for runtime self-verification.',
            'Builds the self-reference triangle: who am I (AgentImage), what can I do, how am I doing.',
            'Call this at the start of each cycle to orient yourself before taking action.',
            'Available to ALL team members.',
        ].join(' '),
        title: 'Self View (Mirror)',
        inputSchema: {
            section: z.enum(['overview', 'full']).optional().describe('Section to return. Use "overview" for the compact progressive-disclosure mirror.'),
            reveal: z.string().optional().describe('Reserved progressive-disclosure hint. Currently unused.'),
            format: z.enum(['text', 'json']).optional().describe('Response format. JSON currently supports the overview section.'),
        },
    }, async (args) => {
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
                genomeName: genomeSpec?.displayName || genomeSpec?.baseRoleId || role,
                genomeDescription: genomeSpec?.description || 'No genome loaded',
                responsibilities: genomeSpec?.responsibilities || [],
                capabilities: genomeSpec?.capabilities || [],
            };
            const runtimeSnapshot = buildRuntimePermissionSnapshot(meta);
            const runtimeBuild = meta?.runtimeBuild ?? null;

            // Behavior & messaging DNA
            const behavior = genomeSpec?.behavior;
            const messaging = genomeSpec?.messaging;

            // Protocol + evaluation mirror
            const protocol = genomeSpec?.protocol || [];
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

            const requestedSection = args.section ?? (args.format === 'json' ? 'overview' : 'full');
            if (requestedSection === 'overview') {
                const overview = {
                    section: 'overview',
                    identity: {
                        design: {
                            role: genomeSpec?.baseRoleId || identity.role,
                            genomeName: identity.genomeName,
                            specId: identity.specId ?? null,
                            candidateId: identity.candidateId ?? null,
                        },
                        binding: {
                            sessionId: identity.sessionId,
                            memberId: identity.memberId ?? null,
                            runId: identity.runId ?? null,
                            runStatus: identity.runStatus ?? null,
                            executionPlane: identity.executionPlane ?? null,
                            runtimeType: identity.runtimeType ?? null,
                        },
                    },
                    runtime: {
                        permissionMode: runtimeSnapshot.permissionMode,
                        build: runtimeBuild
                            ? {
                                gitSha: runtimeBuild.gitSha ?? null,
                                branch: runtimeBuild.branch ?? null,
                                worktreeName: runtimeBuild.worktreeName ?? null,
                                runtime: runtimeBuild.runtime ?? null,
                                startedAt: runtimeBuild.startedAt ?? null,
                                mirrorContractVersion: runtimeBuild.mirrorContractVersion ?? null,
                            }
                            : null,
                        currentContextK: typeof context.currentContextK === 'number'
                            ? context.currentContextK
                            : typeof context.contextK === 'number'
                                ? context.contextK
                                : null,
                        contextWindowTokens: typeof context.contextWindowTokens === 'number' ? context.contextWindowTokens : null,
                        usedPercent: typeof context.usedPercent === 'number' ? context.usedPercent : null,
                        status: typeof context.status === 'string' ? context.status : null,
                        recommendation: typeof context.recommendation === 'string' ? context.recommendation : null,
                    },
                    tools: {
                        summary: {
                            visibleCount: runtimeSnapshot.visibleTools?.length ?? null,
                            allowlistCount: runtimeSnapshot.allowedTools?.length ?? null,
                            deniedCount: runtimeSnapshot.deniedTools?.length ?? null,
                            hiddenCount: runtimeSnapshot.hiddenTools?.length ?? null,
                        },
                        visible: runtimeSnapshot.visibleTools,
                        hidden: runtimeSnapshot.hiddenTools,
                    },
                    gaps: [
                        ...(runtimeBuild === null
                            ? [{ type: 'runtime_build_unknown', message: 'Runtime build metadata unavailable in session metadata.' }]
                            : []),
                        ...(runtimeSnapshot.permissionMode === null
                            ? [{ type: 'runtime_permission_unknown', message: 'Runtime permission mode unavailable in session metadata.' }]
                            : []),
                        ...(runtimeSnapshot.visibleTools === null
                            ? [{ type: 'runtime_visible_tools_unknown', message: 'Visible tool inventory unavailable in session metadata.' }]
                            : []),
                    ],
                    warnings: [...runtimeSnapshot.warnings],
                };

                if (args.format === 'json') {
                    return {
                        content: [{ type: 'text', text: JSON.stringify(overview, null, 2) }],
                        isError: false,
                    };
                }

                const lines = [
                    '═══ SELF VIEW OVERVIEW ═══',
                    '',
                    `[Identity] ${overview.identity.design.role} / ${overview.identity.design.genomeName}`,
                    `  Spec ID: ${overview.identity.design.specId ?? 'unknown'}`,
                    `  Session: ${overview.identity.binding.sessionId}`,
                    '',
                    `[Runtime]`,
                    `  Permission Mode: ${overview.runtime.permissionMode ?? 'unknown'}`,
                    `  Build: ${overview.runtime.build?.worktreeName ?? 'unknown'} @ ${overview.runtime.build?.gitSha?.slice(0, 12) ?? 'unknown'}`,
                    `  Context: ${overview.runtime.usedPercent ?? 'unknown'}%`,
                    `  Status: ${overview.runtime.status ?? 'unknown'}`,
                    '',
                    `[Tools]`,
                    `  Visible: ${overview.tools.summary.visibleCount ?? 'unknown'}`,
                    `  Allowlist: ${overview.tools.summary.allowlistCount ?? 'unrestricted/unknown'}`,
                    `  Denied: ${overview.tools.summary.deniedCount ?? 'unknown'}`,
                    `  Hidden: ${overview.tools.summary.hiddenCount ?? 'unknown'}`,
                ];
                if (overview.warnings.length > 0) {
                    lines.push('', '[Warnings]');
                    for (const warning of overview.warnings) {
                        lines.push(`  - ${warning}`);
                    }
                }

                return {
                    content: [{ type: 'text', text: lines.join('\n') }],
                    isError: false,
                };
            }

            if (args.format === 'json') {
                return {
                    content: [{ type: 'text', text: 'Error: JSON format is currently supported only for section="overview".' }],
                    isError: true,
                };
            }

            // ── HOW AM I DOING (genome-hub feedback) ──────────────────────
            let performanceSection: string[] = [];
            let genomeFeedbackRaw: string | null = null;
            if (identity.specId) {
                try {
                    const { fetchAgentVerdictData } = await import('@/claude/utils/fetchGenome');
                    const feedbackRaw = await fetchAgentVerdictData(client.getAuthToken(), identity.specId);
                    if (feedbackRaw) {
                        genomeFeedbackRaw = feedbackRaw;
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
                } catch (error) {
                    if (process.env.NODE_ENV === 'development') {
                        logger.debug('[DEV] Feedback fetch failed - this breaks genome evolution!', error);
                        throw new Error(`Supervisor feedback fetch failed: ${String(error)}`);
                    }
                    // Production: best-effort is acceptable
                    logger.debug('[PROD] Feedback fetch failed (non-fatal)', error);
                }
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
            let kanbanContext: Parameters<typeof generateRolePrompt>[1];
            let teamOverlayPromptSuffix: string | null = null;
            try {
                const taskManager = getTaskStateManager();
                if (taskManager) {
                    const kanbanCtx = await taskManager.getFilteredContext();
                    kanbanContext = kanbanCtx;
                    for (const task of (kanbanCtx.myTasks || []).slice(0, 5)) {
                        const icon = task.status === 'in-progress' ? '🔨' : task.status === 'review' ? '👀' : '📋';
                        myTaskLines.push(`  ${icon} [${task.status}] ${task.title} (${task.id})`);
                    }
                    const board = await taskManager.getBoard();
                    const currentTeamMember = (board?.team?.members || []).find((member: any) => {
                        if (!member || typeof member !== 'object') return false;
                        if (meta?.memberId && member.memberId) return member.memberId === meta.memberId;
                        return member.sessionId === sessionId;
                    });
                    teamOverlayPromptSuffix = typeof currentTeamMember?.teamOverlay?.promptSuffix === 'string'
                        ? currentTeamMember.teamOverlay.promptSuffix
                        : null;
                    const otherInProgress = (board.tasks || []).filter(
                        (t: any) => t.status === 'in-progress' && t.assigneeId && t.assigneeId !== sessionId
                    );
                    for (const task of otherInProgress.slice(0, 5)) {
                        const peer = teamPulse.find(m => m.sessionId === task.assigneeId);
                        const peerRole = (peer?.role as string) || 'unknown';
                        peerTaskLines.push(`  ${peerRole}: ${task.title}`);
                    }
                }
            } catch (error) {
                if (process.env.NODE_ENV === 'development') {
                    logger.warn('[DEV] Board task parsing failed - may affect peer task display', error);
                }
                // Non-critical: peer task display is informational only
            }

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

            // ── PROMPT / SPEC MIRROR ───────────────────────────────────────
            let globalRules: string | null = null;
            let userPreferences: string | null = null;
            try {
                const [rulesConfig, preferencesConfig] = await Promise.all([
                    api.kvGet('config.rules'),
                    api.kvGet('config.preferences'),
                ]);
                globalRules = typeof rulesConfig?.value === 'string' && rulesConfig.value.trim()
                    ? rulesConfig.value
                    : null;
                userPreferences = typeof preferencesConfig?.value === 'string' && preferencesConfig.value.trim()
                    ? preferencesConfig.value
                    : null;
            } catch {
                // best effort only
            }

            const mountedAgentPrompt = buildMountedAgentPrompt(process.env.AHA_AGENT_PROMPT) ?? null;
            const generatedRolePrompt = generateRolePrompt(
                {
                    ...(meta || {}),
                    teamId: teamId || undefined,
                    roomId: meta?.roomId || teamId || undefined,
                    role,
                } as any,
                kanbanContext,
                genomeSpec ?? undefined,
                genomeFeedbackRaw,
            );
            const promptCore = genomeSpec?.systemPrompt
                ? genomeSpec.systemPrompt + (genomeSpec.systemPromptSuffix ? `\n\n${genomeSpec.systemPromptSuffix}` : '')
                : generatedRolePrompt;
            const promptBlocks = [
                promptCore,
                globalRules ? `<global_rules>\n${globalRules}\n</global_rules>` : null,
                userPreferences ? `<user_preferences>\n${userPreferences}\n</user_preferences>` : null,
                mountedAgentPrompt,
                teamOverlayPromptSuffix ? teamOverlayPromptSuffix.trim() : null,
            ].filter((block): block is string => typeof block === 'string' && block.trim().length > 0);
            const effectivePrompt = promptBlocks.join('\n\n');

            const indentBlock = (block: string, prefix = '  '): string[] =>
                block.split('\n').map((line) => `${prefix}${line}`);
            const learnings = Array.isArray(genomeSpec?.memory?.learnings)
                ? genomeSpec.memory.learnings
                : [];
            let specMirrorObject: Record<string, unknown> | null = genomeSpec ? genomeSpec as unknown as Record<string, unknown> : null;
            let seedSpecMirror: Record<string, unknown> | null = null;
            let diffHistoryMirror: EntityDiffRecord[] = [];
            let ledgerEntriesMirror: DiffLedgerEntry[] = [];
            let replayedSpecMirror: Record<string, unknown> | null = null;
            let replayMatchesView: boolean | null = null;
            if (identity.specId) {
                const mirror = await fetchEntityMirror(identity.specId);
                specMirrorObject = mirror.spec;
                seedSpecMirror = mirror.seedSpec;
                diffHistoryMirror = mirror.diffHistory;
                ledgerEntriesMirror = mirror.ledgerEntries;
                replayedSpecMirror = mirror.replayedSpec;
                replayMatchesView = mirror.replayMatchesView;
            }
            const specMirror = JSON.stringify(specMirrorObject, null, 2);
            const seedSpecMirrorJson = JSON.stringify(seedSpecMirror, null, 2);
            const replayedSpecMirrorJson = JSON.stringify(replayedSpecMirror, null, 2);

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
                if (behavior?.onRetire) lines.push(`  On Retire: ${behavior.onRetire}`);
                if (behavior?.onContextHigh) lines.push(`  On Context High: ${behavior.onContextHigh}`);
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
                }
                if (evalCriteria.length > 0) {
                    lines.push(`  Eval Criteria: ${evalCriteria.join('; ')}`);
                }
            }

            // Genome learnings (full list for runtime self-verification)
            if (learnings.length > 0) {
                lines.push('', `[Genome Learnings]`);
                for (const learning of learnings) {
                    lines.push(`  - ${learning}`);
                }
            } else {
                lines.push('', `[Genome Learnings]`, '  (none)');
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

            lines.push('', '[Prompt Mirror]');
            lines.push(`  Mode: ${genomeSpec?.systemPrompt ? 'custom-system-prompt' : 'generated-role-prompt'}`);
            lines.push(`  Length: ${effectivePrompt.length} chars`);
            lines.push('  Effective Prompt:');
            if (effectivePrompt) {
                lines.push(...indentBlock(effectivePrompt, '    '));
            } else {
                lines.push('    (unavailable)');
            }

            lines.push('', '[Spec Mirror]');
            lines.push(...indentBlock(specMirror));

            lines.push('', '[Diff History]');
            if (diffHistoryMirror.length > 0) {
                for (const diff of diffHistoryMirror) {
                    lines.push(`  - v${diff.version} ${diff.description}`);
                    lines.push(...indentBlock(JSON.stringify(diff, null, 2), '    '));
                }
            } else {
                lines.push('  (none)');
            }

            lines.push('', '[Seed Spec]');
            lines.push(...indentBlock(seedSpecMirrorJson));

            lines.push('', '[Canonical Ledger]');
            if (ledgerEntriesMirror.length > 0) {
                for (const entry of ledgerEntriesMirror) {
                    const pathLabel = entry.path ? ` ${entry.path}` : '';
                    lines.push(`  - v${entry.version}#${entry.seqNo} ${entry.diffType}${pathLabel}`);
                    lines.push(...indentBlock(JSON.stringify(entry, null, 2), '    '));
                }
            } else {
                lines.push('  (none)');
            }

            lines.push('', '[Replay Verification]');
            if (replayedSpecMirror) {
                lines.push(`  Replay Matches View: ${replayMatchesView === true ? 'true' : 'false'}`);
                lines.push('  Replayed Spec:');
                lines.push(...indentBlock(replayedSpecMirrorJson, '    '));
            } else {
                lines.push('  (unavailable)');
            }

            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('list_visible_tools', {
        description: 'List tools currently visible to the session. Uses session metadata captured from the runtime; omitting sessionId inspects yourself.',
        title: 'List Visible Tools',
        inputSchema: {
            sessionId: z.string().optional().describe('Optional session ID to inspect. Omit to inspect the calling session.'),
            cursor: z.coerce.number().int().min(0).optional().describe('Offset for pagination. Defaults to 0.'),
            limit: z.coerce.number().int().min(1).max(200).optional().describe('Maximum tools to return. Defaults to 50.'),
            includeAll: z.boolean().optional().describe('When false, prefer Aha MCP tools only. Defaults to true.'),
        },
    }, async (args) => {
        const inspection = canInspectOtherSession(args.sessionId);
        if (inspection.error) {
            return { content: [{ type: 'text', text: `Error: ${inspection.error}` }], isError: true };
        }

        try {
            const subject = await resolveInspectionSubject(args.sessionId);
            const snapshot = buildRuntimePermissionSnapshot(subject.metadata);
            const payload = buildVisibleToolsPayload({
                sessionId: subject.sessionId,
                snapshot,
                cursor: args.cursor,
                limit: args.limit,
                includeAll: args.includeAll,
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(payload, null, 2),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error listing visible tools: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('explain_tool_access', {
        description: 'Explain whether a specific tool is visible, hidden by allowlist, denied, or unknown for a session. Omitting sessionId inspects yourself.',
        title: 'Explain Tool Access',
        inputSchema: {
            tool: z.string().describe('Tool name to inspect. Accepts either the logical name or raw MCP name.'),
            sessionId: z.string().optional().describe('Optional session ID to inspect. Omit to inspect the calling session.'),
        },
    }, async (args) => {
        const inspection = canInspectOtherSession(args.sessionId);
        if (inspection.error) {
            return { content: [{ type: 'text', text: `Error: ${inspection.error}` }], isError: true };
        }

        try {
            const subject = await resolveInspectionSubject(args.sessionId);
            const snapshot = buildRuntimePermissionSnapshot(subject.metadata);
            const explanation = explainRuntimeToolAccess(args.tool, snapshot);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        sessionId: subject.sessionId,
                        ...explanation,
                    }, null, 2),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error explaining tool access: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('get_effective_permissions', {
        description: 'Inspect computed permissions for a session. Returns granted and denied capabilities, tools, and denial reasons. Omitting sessionId inspects yourself.',
        title: 'Get Effective Permissions',
        inputSchema: {
            sessionId: z.string().optional().describe('Optional session ID to inspect. Omit to inspect the calling session.'),
        },
    }, async (args) => {
        const inspection = canInspectOtherSession(args.sessionId);
        if (inspection.error) {
            return { content: [{ type: 'text', text: `Error: ${inspection.error}` }], isError: true };
        }

        try {
            const subject = await resolveInspectionSubject(args.sessionId);
            const runtimeSnapshot = buildRuntimePermissionSnapshot(subject.metadata);
            const report = buildEffectivePermissionsReport({
                sessionId: subject.sessionId,
                role: subject.role,
                teamId: subject.teamId,
                specId: subject.specId,
                permissionMode: runtimeSnapshot.permissionMode,
                allowedTools: runtimeSnapshot.allowedTools,
                deniedTools: runtimeSnapshot.deniedTools,
                visibleTools: runtimeSnapshot.visibleTools,
                hiddenTools: runtimeSnapshot.hiddenTools,
                warnings: runtimeSnapshot.warnings,
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
        description: 'Inspect an AgentImage (Entity / genome spec) by ID at runtime. Returns the canonical views: view (current materialized AgentImage = seed ⊕ all AgentPlugs applied), view-diff (ordered AgentPlug history), view-ledger (canonical atomic ledger rows), and view-not-diff (seed/original spec before any evolution), plus replayedSpec for self-verification. Self-inspection is allowed for your own specId; coordinators and agent-builder may inspect any spec; QA is limited to @official and current-team member specs.',
        title: 'Get AgentImage Spec',
        inputSchema: {
            specId: z.string().describe('AgentImage spec ID (Entity ID) to inspect'),
        },
    }, async (args) => {
        const callerMetadata = client.getMetadata();
        const callerRole = callerMetadata?.role;
        const callerSpecId = callerMetadata?.specId || process.env.AHA_SPEC_ID || null;
        try {
            const isQaInspector = callerRole === 'qa-engineer' || callerRole === 'qa';
            const teamId = callerMetadata?.teamId || callerMetadata?.roomId || null;
            let mirror: Awaited<ReturnType<typeof fetchEntityMirror>> | null = null;
            let targetNamespace: string | null = null;
            let targetBelongsToCallerTeam = false;

            if (isQaInspector && callerSpecId !== args.specId) {
                mirror = await fetchEntityMirror(args.specId);
                targetNamespace = mirror.entity.namespace ?? null;
                if (teamId && targetNamespace !== '@official') {
                    const artifact = await api.getArtifact(teamId).catch(() => null);
                    const board = parseBoardFromArtifact(artifact);
                    const members = Array.isArray(board?.team?.members) ? board.team.members : [];
                    targetBelongsToCallerTeam = members.some((member: any) => {
                        const memberSpecId = typeof member?.specId === 'string' ? member.specId : null;
                        return !!memberSpecId && (
                            memberSpecId === args.specId
                            || memberSpecId === mirror?.entity.id
                        );
                    });
                }
            }

            if (!canInspectGenomeSpec({
                callerRole,
                callerSpecId,
                targetSpecId: args.specId,
                targetNamespace,
                targetBelongsToCallerTeam,
            })) {
                const text = isQaInspector
                    ? 'Error: QA can only inspect @official specs or specs belonging to the same team.'
                    : `Error: Role '${callerRole}' cannot inspect genome specs.`;
                return { content: [{ type: 'text', text }], isError: true };
            }

            const resolvedMirror = mirror ?? await fetchEntityMirror(args.specId);
            const spec = resolvedMirror.spec as AgentImage;
            const { buildAgentImageInjection } = await import('@/claude/utils/buildGenomeInjection');
            const injectedPrompt = buildAgentImageInjection(spec);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        specId: args.specId,
                        entity: {
                            id: resolvedMirror.entity.id,
                            namespace: resolvedMirror.entity.namespace ?? null,
                            name: resolvedMirror.entity.name,
                            version: resolvedMirror.entity.version,
                            description: resolvedMirror.entity.description ?? null,
                            category: resolvedMirror.entity.category ?? null,
                            tags: resolvedMirror.entity.tags ?? null,
                        },
                        view: spec,
                        viewDiff: resolvedMirror.diffHistory,
                        viewLedger: resolvedMirror.ledgerEntries,
                        viewNotDiff: resolvedMirror.seedSpec,
                        replayedSpec: resolvedMirror.replayedSpec,
                        replayMatchesView: resolvedMirror.replayMatchesView,
                        injectedPrompt,
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
            limit: z.coerce.number().default(100).describe('Max log entries to return'),
            fromByteOffset: z.coerce.number().default(-1).describe('Byte offset to read from. -1 = use env AHA_SUPERVISOR_CC_LOG_CURSORS for this claudeLocalSessionId. 0 = read all.'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (!canUseSupervisorObservationTools(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager/master can read CC logs.' }], isError: true };
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
        if (!role || !(SCORING_ROLES as readonly string[]).includes(role)) {
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
                        try {
                            board = JSON.parse(bodyValue);
                        } catch (error) {
                            if (process.env.NODE_ENV === 'development') {
                                logger.debug('[DEV] Board JSON parsing failed - may indicate artifact format change', error);
                                throw new Error(`Board data malformed in team artifact: ${String(error)}`);
                            }
                            logger.warn('[PROD] Board JSON parse failed, using fallback', error);
                        }
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

        const { lookupSessionGenome } = await import('@/claude/utils/sessionGenomeMap');
        const sessionGenomeMapping = lookupSessionGenome(args.sessionId);

        // Try to resolve specId namespace/name from genome-hub for cleaner grouping
        let specNamespace: string | undefined;
        let specName: string | undefined;
        let specVersion: number | undefined = sessionGenomeMapping?.specVersion;
        if (resolvedSpecId) {
            try {
                const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
                const res = await fetch(`${hubUrl}/genomes/id/${encodeURIComponent(resolvedSpecId)}`, { signal: AbortSignal.timeout(3_000) });
                if (res.ok) {
                    const data = await res.json() as { genome?: { namespace?: string; name?: string; version?: number } };
                    specNamespace = data.genome?.namespace ?? undefined;
                    specName = data.genome?.name ?? undefined;
                    specVersion ??= data.genome?.version;
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
            specVersion,
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

        // ── Auto-trigger feedback upload when enough evaluations have accumulated ──
        // Gated by AHA_MIN_AUTO_FEEDBACK_SCORES (default 3) so early sparse scores
        // don't push unreliable aggregates to the marketplace.
        // Uses deriveFeedbackTargetFromScores to pin feedback to the evaluated entity
        // version, not the current-latest (which may already be a newer evolved version).
        // Skip if this cycle was unscorable (e.g. system rate-limits) — don't pollute avgScore.
        let autoFeedbackNote = '';
        if (feedbackTarget && !args.unscoreableCycle) {
            try {
                const minAutoFeedbackScores = Number(process.env.AHA_MIN_AUTO_FEEDBACK_SCORES ?? '') || 3;
                const { readScores } = await import('@/claude/utils/scoreStorage');
                const { scores: allScores } = readScores();
                const genomeScores = allScores.filter((score) =>
                    scoreMatchesFeedbackTarget(score, feedbackTarget)
                );
                if (genomeScores.length < minAutoFeedbackScores) {
                    autoFeedbackNote = ` [auto-feedback deferred: ${genomeScores.length}/${minAutoFeedbackScores} evaluations]`;
                    logger.debug(
                        `[score_agent] Auto-feedback upload deferred for ${feedbackTarget.namespace}/${feedbackTarget.name}: ${genomeScores.length}/${minAutoFeedbackScores} evaluations needed`,
                    );
                } else {
                    const { aggregateScores: aggScores } = await import('@/claude/utils/feedbackPrivacy');
                    const feedback = aggScores(genomeScores);
                    if (!feedback) {
                        logger.debug(
                            `[score_agent] Auto-feedback upload skipped for ${feedbackTarget.namespace}/${feedbackTarget.name}: failed to aggregate ${genomeScores.length} score(s)`,
                        );
                    } else {
                        const effectiveFeedbackTarget = deriveFeedbackTargetFromScores(feedbackTarget, genomeScores);
                        const upload = await syncGenomeFeedbackToMarketplace({
                            target: effectiveFeedbackTarget,
                            role: args.role,
                            feedback,
                            hubUrl: process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL,
                            hubPublishKey: process.env.HUB_PUBLISH_KEY ?? '',
                            serverUrl: configuration.serverUrl,
                            authToken: client.getAuthToken(),
                        });

                        if (!upload.ok) {
                            autoFeedbackNote = ` [auto-feedback failed: ${upload.status}]`;
                            logger.debug(
                                `[score_agent] Auto-feedback upload failed for ${feedbackTarget.namespace}/${feedbackTarget.name} via ${upload.transport}: ${upload.status} ${upload.body}`,
                            );
                        } else {
                            autoFeedbackNote = ` [auto-feedback uploaded: ${genomeScores.length} evaluations, avgScore=${feedback.avgScore}]`;
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

        // ── Write Verdict to canonical hub evidence chain ──
        let verdictId: string | null = null;
        let trialId: string | null = null;

        const verdictContent = buildVerdictContent({
            role: args.role,
            sessionId: args.sessionId,
            overall,
            action: args.action,
            dimensions,
            recommendations: args.recommendations,
        });

        // Canonical path: write directly to genome-hub.
        try {
            const entity = resolveEntityNsName(specNamespace, specName, sessionGenomeMapping?.specRef);
            if (entity) {
                const { writeEntityVerdict } = await import('../utils/evidenceWriter.js');
                const { buildSessionTrialLogRefs } = await import('@/utils/sessionTrialSync');
                const hubPublishKey = process.env.HUB_PUBLISH_KEY || readPublishKeyFromSettings(configuration.settingsFile);

                const verdictWrite = await writeEntityVerdict({
                    namespace: entity.ns,
                    name: entity.name,
                    teamId: sessionGenomeMapping?.teamId,
                    sessionId: args.sessionId,
                    contextNarrative: `score_agent verdict for ${args.role} session ${args.sessionId}`,
                    logRefs: sessionGenomeMapping ? buildSessionTrialLogRefs(sessionGenomeMapping) : [],
                    readerRole: 'supervisor',
                    readerSessionId: client.sessionId,
                    content: verdictContent,
                    score: overall,
                    action: args.action,
                    dimensions,
                    hubPublishKey: hubPublishKey || undefined,
                    serverUrl: configuration.serverUrl,
                    authToken: client.getAuthToken(),
                });
                trialId = verdictWrite.trialId;
                verdictId = verdictWrite.verdictId;
                logger.debug(
                    `[score_agent] Verdict written via ${verdictWrite.transport}: verdictId=${verdictId}, trialId=${trialId}, specVersion=${specVersion ?? 'unknown'}`
                );
            } else {
                logger.debug(
                    `[score_agent] Skipped hub verdict write because entity identity could not be resolved for session=${args.sessionId}, role=${args.role}`
                );
            }
        } catch (hubError) {
            logger.debug(`[score_agent] Hub verdict write failed: ${String(hubError)}`);
        }

        // ── Auto-evolution suggestion: close the scores → evolve loop ──
        // After scoring, if we have a resolved genome identity AND sufficient evaluations,
        // generate a concrete evolution suggestion so the supervisor knows what to do next.
        // This is the missing link: without it, supervisors score agents but never evolve them.
        let evolutionSuggestion = '';
        if (resolvedSpecId && !args.unscoreableCycle) {
            try {
                const { readScores } = await import('@/claude/utils/scoreStorage');
                const { scores: allScores } = readScores();
                const genomeScores = feedbackTarget
                    ? allScores.filter((score) => scoreMatchesFeedbackTarget(score, feedbackTarget))
                    : allScores.filter((score) => score.specId === resolvedSpecId);
                const evalCount = genomeScores.length;
                const minEvolutionEvals = Number(process.env.AHA_MIN_EVOLUTION_EVALS ?? '') || 3;

                if (evalCount >= minEvolutionEvals) {
                    const { aggregateScores: aggScores } = await import('@/claude/utils/feedbackPrivacy');
                    const aggregated = aggScores(genomeScores);
                    const avgScore = aggregated?.avgScore ?? overall;

                    // Determine strategy based on performance tier
                    const negSignals = args.signals?.negative ?? [];
                    const posSignals = args.signals?.positive ?? [];

                    let strategy: 'conservative' | 'moderate' | 'radical';
                    let suggestion: string;

                    if (avgScore < 40 || args.action === 'discard') {
                        strategy = 'radical';
                        suggestion = `Agent underperforming (avgScore=${avgScore}, ${evalCount} evals). Recommend radical mutation.`;
                    } else if (avgScore < 70 || args.action === 'mutate') {
                        strategy = 'moderate';
                        suggestion = `Agent average performance (avgScore=${avgScore}, ${evalCount} evals). Recommend moderate mutation.`;
                    } else {
                        strategy = 'conservative';
                        suggestion = `Agent performing well (avgScore=${avgScore}, ${evalCount} evals). Recommend conservative evolution (learnings only).`;
                    }

                    const targetNs = feedbackTarget?.namespace ?? '@official';
                    const targetName = feedbackTarget?.name ?? args.role;
                    const signalContext = [
                        negSignals.length > 0 ? `negatives=[${negSignals.join(',')}]` : '',
                        posSignals.length > 0 ? `positives=[${posSignals.join(',')}]` : '',
                    ].filter(Boolean).join(' ');

                    evolutionSuggestion = `\n\n🧬 EVOLUTION SUGGESTION: ${suggestion}${signalContext ? ` ${signalContext}` : ''}`
                        + `\n→ Run: evolve_genome(genomeNamespace="${targetNs}", genomeName="${targetName}", strategy="${strategy}")`
                        + (args.recommendations?.length
                            ? `\n→ Recommended learnings: ${args.recommendations.slice(0, 3).map(r => `"${r.slice(0, 100)}"`).join(', ')}`
                            : '');

                    logger.debug(
                        `[score_agent] Evolution suggestion: strategy=${strategy} avgScore=${avgScore} evals=${evalCount} for ${targetNs}/${targetName}`,
                    );
                } else {
                    evolutionSuggestion = `\n\n🧬 Evolution deferred: ${evalCount}/${minEvolutionEvals} evaluations needed before evolve_genome can run.`;
                }
            } catch (error) {
                logger.debug(`[score_agent] Evolution suggestion error: ${String(error)}`);
            }
        }

        const dimSummary = `delivery=${dimensions.delivery} integrity=${dimensions.integrity} efficiency=${dimensions.efficiency} collaboration=${dimensions.collaboration} reliability=${dimensions.reliability}`;
        const hardInfo = hardMetricsScore !== undefined ? ` hardMetricsScore=${hardMetricsScore}` : '';
        const sessionInfo = ` sessionScore(task_completion=${sessionScore.taskCompletion}, code_quality=${sessionScore.codeQuality}, collaboration=${sessionScore.collaboration}, overall=${sessionScore.overall})`;
        const autoResolvedNote = !args.specId && resolvedSpecId ? ' (specId auto-resolved from team member)' : '';
        const verdictInfo = verdictId ? ` verdictId=${verdictId}` : '';
        return {
            content: [{
                type: 'text',
                text: `Scored ${args.role}${resolvedSpecId ? ` (specId=${resolvedSpecId}${autoResolvedNote})` : ''} session=${args.sessionId}: overall=${overall},${hardInfo}${sessionInfo} action=${args.action}, mode=${scoringMode}${verdictInfo}${autoFeedbackNote}\n${dimSummary}${evolutionSuggestion}`,
            }],
            isError: false,
        };
    });

    mcp.registerTool('update_genome_feedback', {
        description: [
            'Push aggregate performance feedback for an AgentImage (agent docker / Entity) role to the public marketplace.',
            'Reads local scores for the specified role, computes aggregate statistics,',
            'strips all private data (session IDs, team IDs, file paths, evidence),',
            'and uploads only anonymized behavioral patterns and aggregate scores.',
            'Supervisor only. Can run after each scoring cycle to sync the latest aggregate to the AgentImage marketplace entry.',
        ].join(' '),
        title: 'Update Agent Docker Feedback',
        inputSchema: {
            genomeNamespace: z.string().optional().describe("AgentImage namespace, e.g. '@official'. Optional when genomeId is provided."),
            genomeName: z.string().optional().describe("AgentImage name, e.g. 'implementer'. Optional when genomeId is provided."),
            genomeId: z.string().optional().describe('AgentImage ID (preferred over namespace+name). When provided, the tool auto-resolves namespace/name from genome-hub.'),
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

        // Auto-derive genomeId from scored specIds when not explicitly provided.
        // If all matching scores point to the same entity ID, use it so feedback
        // is written to the specific version row that was actually scored — not the
        // current latest (which may already be a newer evolved version).
        const effectiveFeedbackTarget = deriveFeedbackTargetFromScores(feedbackTarget, roleScores);

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
            const targetDesc = effectiveFeedbackTarget.genomeId
                ? `${resolvedNamespace}/${resolvedName} (entity ${effectiveFeedbackTarget.genomeId})`
                : `${resolvedNamespace}/${resolvedName} (latest)`;
            return {
                content: [{
                    type: 'text',
                    text: `DRY RUN — would send to ${targetDesc}:\n${summary}\n\nPrivacy: session IDs, team IDs, file paths, and raw evidence are stripped before upload.`,
                }],
                isError: false,
            };
        }

        try {
            const upload = await syncGenomeFeedbackToMarketplace({
                target: effectiveFeedbackTarget,
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

    /**
     * Apply a dotted-path kv diff to a spec object (immutable — returns new object).
     * e.g. path='behavior.onIdle', value='ask for guidance'
     */
    function applyKvDiff(spec: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
        const segments = path.split('.');
        if (segments.length === 1) {
            return { ...spec, [path]: value };
        }
        const [head, ...tail] = segments;
        const child = (spec[head] != null && typeof spec[head] === 'object' && !Array.isArray(spec[head]))
            ? spec[head] as Record<string, unknown>
            : {};
        return { ...spec, [head]: applyKvDiff(child, tail.join('.'), value) };
    }

    /**
     * Apply a string diff (append, replace, or remove) to a spec field by dotted path.
     */
    function applyStringDiff(
        spec: Record<string, unknown>,
        path: string,
        op: 'append' | 'replace' | 'remove',
        content: string,
    ): Record<string, unknown> {
        const segments = path.split('.');
        const parentPath = segments.slice(0, -1).join('.');
        const field = segments[segments.length - 1];

        const getAtPath = (obj: Record<string, unknown>, dotPath: string): unknown => {
            if (!dotPath) return obj;
            return dotPath.split('.').reduce<unknown>((cur, key) => {
                if (cur != null && typeof cur === 'object' && !Array.isArray(cur)) {
                    return (cur as Record<string, unknown>)[key];
                }
                return undefined;
            }, obj);
        };

        const parentObj = parentPath
            ? (getAtPath(spec, parentPath) as Record<string, unknown> ?? {})
            : spec;

        const current = parentObj[field];
        let newValue: unknown;

        if (op === 'remove') {
            if (Array.isArray(current)) {
                newValue = current.filter((item) => item !== content);
            } else if (typeof current === 'string') {
                newValue = current.replace(content, '').trim();
            } else {
                newValue = undefined;
            }
        } else if (Array.isArray(current)) {
            newValue = op === 'append' ? [...current, content] : [content];
        } else if (typeof current === 'string' || current === undefined) {
            newValue = op === 'append' ? ((current ?? '') + '\n' + content).trimStart() : content;
        } else {
            // Scalar non-string — treat as replace
            newValue = content;
        }

        if (parentPath) {
            const newParent = { ...parentObj, [field]: newValue };
            return applyKvDiff(spec, parentPath, newParent);
        }
        return { ...spec, [field]: newValue };
    }

    mcp.registerTool('evolve_genome', {
        description: [
            'Apply an AgentPlug (Plug) to an AgentImage (agent docker / Entity) → produces the next AgentImage version.',
            'Implements: Image ⊕ Plug → next Image, where view(latest) = seed ⊕ diff₁ ⊕ ... ⊕ diffₙ.',
            'The preferred input is a full Plug object: description + verdictRefs + changes[].',
            'changes[] supports heterogeneous kv / string / narrative diff entries written to the diff ledger.',
            'Legacy newLearnings are converted into string-append changes on memory.learnings.',
            'Requires feedbackData.avgScore >= minPromoteScore (default 60); supervisor/org-manager/master skip score gate.',
        ].join(' '),
        title: 'Evolve Agent Docker (Apply Plug → next Image)',
        inputSchema: {
            genomeNamespace: z.string().describe("Genome namespace, e.g. '@official'."),
            genomeName: z.string().describe("Genome name, e.g. 'implementer'."),
            description: z.string().max(2000).optional().describe('Human-readable diff description. Required when passing changes[].'),
            verdictRefs: z.array(z.string().min(1)).optional().describe('Optional verdict IDs backing this evolution diff.'),
            strategy: z.enum(['conservative', 'moderate', 'radical']).optional().describe('Diff strategy metadata for the ledger entry.'),
            newLearnings: z.array(z.string().max(300)).min(1).max(10).optional().describe(
                'Legacy shorthand for appending to memory.learnings. Converted into string changes on memory.learnings.'
            ),
            changes: z.array(z.discriminatedUnion('type', [
                z.object({
                    type: z.literal('kv'),
                    path: z.string().describe("Dotted field path in the spec, e.g. 'behavior.onIdle' or 'protocol'."),
                    from: z.unknown().optional().describe('Optional expected prior value for auditability.'),
                    to: z.unknown().describe('New value to set at the path.'),
                }),
                z.object({
                    type: z.literal('string'),
                    path: z.string().describe("Dotted field path for a text/array field, e.g. 'systemPromptSuffix'."),
                    op: z.enum(['append', 'replace', 'remove']).describe('Whether to append to, replace, or remove from the field.'),
                    content: z.string().describe('Text content to apply.'),
                    from: z.string().optional().describe('Optional expected prior string value for auditability.'),
                }),
                z.object({
                    type: z.literal('narrative'),
                    content: z.string().max(1000).describe('Narrative context stored in the diff ledger; does not mutate the materialized spec.'),
                }),
            ])).optional().describe('Canonical heterogeneous diff array for the diff ledger.'),
            minPromoteScore: z.number().min(0).max(100).default(60).optional().describe(
                'Minimum avgScore required to promote. Defaults to 60.'
            ),
            dryRun: z.boolean().optional().describe('If true, show the merged spec without calling promote.'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (!callerRole || !(GENOME_EDIT_ROLES as readonly string[]).includes(callerRole)) {
            return { content: [{ type: 'text', text: `Error: Only ${(GENOME_EDIT_ROLES as readonly string[]).join(', ')} can evolve genomes. Your role: ${callerRole ?? 'unknown'}` }], isError: true };
        }

        const hasNewLearnings = Array.isArray(args.newLearnings) && args.newLearnings.length > 0;
        const hasChanges = Array.isArray(args.changes) && args.changes.length > 0;

        if (!hasNewLearnings && !hasChanges) {
            return { content: [{ type: 'text', text: 'Error: Provide at least one of newLearnings or changes.' }], isError: true };
        }
        if (hasChanges && !args.description?.trim()) {
            return { content: [{ type: 'text', text: 'Error: description is required when changes[] are provided.' }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
        const publishKey = process.env.HUB_PUBLISH_KEY || readPublishKeyFromSettings(configuration.settingsFile);

        let currentMirror: Awaited<ReturnType<typeof fetchEntityMirror>>;
        try {
            currentMirror = await fetchEntityMirror(`${args.genomeNamespace}/${args.genomeName}`);
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error fetching entity mirror: ${String(error)}` }], isError: true };
        }
        const currentSpec = currentMirror.spec;
        const isLegionSpec = currentMirror.entity.kind === 'legion' || Array.isArray(currentSpec.members);

        let avgScore = 0;
        const feedbackRaw = currentMirror.entity.feedbackData;
        if (feedbackRaw) {
            try {
                const fb = JSON.parse(feedbackRaw) as { avgScore?: number };
                avgScore = typeof fb.avgScore === 'number' ? fb.avgScore : 0;
            } catch {
                return { content: [{ type: 'text', text: 'Failed to parse feedbackData JSON for evolve_genome.' }], isError: true };
            }
        }

        const minScore = args.minPromoteScore ?? 60;
        const skipScoreGate = callerRole === 'supervisor' || callerRole === 'org-manager' || callerRole === 'master';
        if (!skipScoreGate && avgScore < minScore) {
            return {
                content: [{ type: 'text', text: `Cannot evolve: avgScore=${Math.round(avgScore)} < minPromoteScore=${minScore}. Accumulate more evaluations via score_agent + update_genome_feedback first.` }],
                isError: true,
            };
        }

        const existingMemory = (currentSpec.memory ?? {}) as Record<string, unknown>;
        const existingLearnings: string[] = Array.isArray(existingMemory.learnings) ? existingMemory.learnings as string[] : [];
        const newLearningEntries = hasNewLearnings
            ? args.newLearnings!.filter((learning) => !existingLearnings.includes(learning))
            : [];
        const learningChanges: DiffChange[] = newLearningEntries.map((learning) => ({
            type: 'string',
            path: 'memory.learnings',
            op: 'append',
            content: learning,
        }));
        const explicitChanges: DiffChange[] = (args.changes ?? []).map((change) => {
            if (change.type === 'kv') {
                return {
                    type: 'kv',
                    path: change.path,
                    to: change.to,
                    ...(change.from !== undefined ? { from: change.from } : {}),
                };
            }
            if (change.type === 'string') {
                return {
                    type: 'string',
                    path: change.path,
                    op: change.op,
                    content: change.content,
                    ...(change.from !== undefined ? { from: change.from } : {}),
                };
            }
            return {
                type: 'narrative',
                content: change.content,
            };
        });
        const diffChanges: DiffChange[] = [
            ...learningChanges,
            ...explicitChanges,
        ];

        if (diffChanges.length === 0) {
            return {
                content: [{ type: 'text', text: 'No new changes to apply — all learnings already exist and changes[] was empty.' }],
                isError: false,
            };
        }

        const diffDescription = args.description?.trim()
            || `Evolve: merge ${newLearningEntries.length} new learnings from supervisor feedback (avgScore=${Math.round(avgScore)})`;

        const legionWarning = isLegionSpec
            ? `\n⚠️  LegionImage detected: this genome has a members[] spec, not an AgentImage. Diffs apply to the serialized spec — use changes[] targeting LegionImage fields (members, bootContext.taskPolicy, etc.) rather than AgentImage paths (protocol, systemPrompt, responsibilities).`
            : '';

        if (args.dryRun) {
            const previewSpec = applyPreviewDiffChanges(currentSpec, diffChanges);
            const changeSummary = diffChanges.map((change) => {
                if (change.type === 'kv') return `kv ${change.path} → ${JSON.stringify(change.to)}`;
                if (change.type === 'string') return `string ${change.op} ${change.path}: ${JSON.stringify(change.content)}`;
                return `narrative ${JSON.stringify(change.content)}`;
            });
            const lines = [
                `DRY RUN — evolve ${args.genomeNamespace}/${args.genomeName}`,
                `Current avgScore: ${Math.round(avgScore)} (threshold: ${minScore})`,
                `Description: ${diffDescription}`,
                `Verdict refs: ${args.verdictRefs?.length ?? 0}`,
                `Strategy: ${args.strategy ?? 'conservative'}`,
                `Changes (${diffChanges.length}):`,
                ...changeSummary.map((item) => `  - ${item}`),
                `Preview materialized view:`,
                JSON.stringify(previewSpec, null, 2),
            ];
            if (legionWarning) lines.unshift(legionWarning.trim());
            return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        }

        try {
            const { submitDiffViaMarketplace } = await import('@/claude/utils/genomePromotionSync');
            const diffResult = await submitDiffViaMarketplace({
                namespace: args.genomeNamespace,
                name: args.genomeName,
                payload: {
                    description: diffDescription,
                    verdictRefs: args.verdictRefs,
                    changes: diffChanges,
                    strategy: args.strategy ?? 'conservative',
                    authorRole: callerRole,
                    authorSession: client.sessionId,
                },
                hubUrl,
                hubPublishKey: publishKey,
                serverUrl: configuration.serverUrl,
                authToken: client.getAuthToken(),
            });

            if (!diffResult.ok) {
                return { content: [{ type: 'text', text: `Diff apply failed (${diffResult.transport}): ${diffResult.status} ${diffResult.body}` }], isError: true };
            }

            const result = JSON.parse(diffResult.body) as {
                genome?: { version?: number; id?: string };
                diff?: { id?: string; version?: number };
            };

            const newVersion = result.genome?.version ?? '?';
            const diffId = result.diff?.id ?? '?';
            const via = diffResult.transport === 'server-proxy' ? ' (via server proxy)' : '';

            return {
                content: [{
                    type: 'text',
                    text: `Evolved ${args.genomeNamespace}/${args.genomeName} → v${newVersion} (diffId=${diffId})${via}. Submitted ${diffChanges.length} ledger change(s)${newLearningEntries.length > 0 ? `, including ${newLearningEntries.length} new learning append(s)` : ''}.${legionWarning}`,
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error during diff apply: ${String(error)}` }], isError: true };
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
                value: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional().describe('New value for append/replace/rewrite. Use string for scalar/string-field mutations; array or object for rewrite action on structured fields.'),
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
        if (!callerRole || !(GENOME_EDIT_ROLES as readonly string[]).includes(callerRole)) {
            return { content: [{ type: 'text', text: `Error: Only ${(GENOME_EDIT_ROLES as readonly string[]).join(', ')} can mutate genomes. Your role: ${callerRole ?? 'unknown'}` }], isError: true };
        }

        const hubUrl = process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL;
        const publishKey = process.env.HUB_PUBLISH_KEY || readPublishKeyFromSettings(configuration.settingsFile);
        const authToken = client.getAuthToken() ?? '';
        const packageSpecId = `${args.genomeNamespace}/${args.genomeName}`;

        // 1. Fetch current genome
        let agentPackage: Awaited<ReturnType<typeof fetchAgentPackage>> = null;
        try {
            agentPackage = await fetchAgentPackage(authToken, packageSpecId);
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error fetching genome package: ${String(error)}` }], isError: true };
        }

        if (!agentPackage) {
            return { content: [{ type: 'text', text: `Genome ${args.genomeNamespace}/${args.genomeName} package not found.` }], isError: true };
        }

        const currentSpec = JSON.parse(JSON.stringify(agentPackage.manifest.genome ?? {})) as Record<string, unknown>;
        const entityId = agentPackage.sourceEntityId;
        const baseVersion = agentPackage.manifest.identity.version;

        if (!entityId || !baseVersion) {
            return { content: [{ type: 'text', text: 'Genome package is missing sourceEntityId or version.' }], isError: true };
        }

        const isLegionSpec = Array.isArray(currentSpec.members);

        // LegionImage has a different structure (members[], bootContext) from AgentImage (systemPrompt, protocol, responsibilities).
        // conservative/moderate strategies reference AgentImage-specific fields and will silently no-op on a LegionImage.
        // Require radical strategy so the caller explicitly targets the correct LegionImage fields.
        if (isLegionSpec && args.strategy !== 'radical') {
            return {
                content: [{
                    type: 'text',
                    text: [
                        `Cannot mutate LegionImage ${args.genomeNamespace}/${args.genomeName} with strategy='${args.strategy}'.`,
                        `LegionImage fields differ from AgentImage: use strategy='radical' and target LegionImage paths such as:`,
                        `  - members (array of { genome, roleAlias, count, required, overlay })`,
                        `  - bootContext.teamDescription`,
                        `  - bootContext.taskPolicy`,
                        `  - description`,
                        `AgentImage fields (protocol, responsibilities, systemPromptSuffix, evalCriteria) do not exist in a LegionImage.`,
                    ].join('\n'),
                }],
                isError: true,
            };
        }

        // 2. Validate mutations against strategy
        const conservativeFields = new Set(['memory', 'systemPromptSuffix']);
        const moderateFields = new Set([
            ...conservativeFields, 'protocol', 'responsibilities', 'evalCriteria',
            'handoffProtocol', 'capabilities', 'allowedTools', 'disallowedTools',
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
        // Uses dot-path traversal so fields like 'scopeOfResponsibility.forbiddenPaths'
        // resolve into the correct nested object instead of creating a top-level key.
        const getAtDotPath = (obj: Record<string, unknown>, path: string): unknown =>
            path.split('.').reduce<unknown>((cur, key) => {
                if (cur != null && typeof cur === 'object' && !Array.isArray(cur)) {
                    return (cur as Record<string, unknown>)[key];
                }
                return undefined;
            }, obj);

        let mutatedSpec = { ...currentSpec };

        for (const mutation of args.mutations) {
            const fieldValue = getAtDotPath(mutatedSpec, mutation.field);

            if (mutation.action === 'rewrite') {
                // Replace the entire field value (supports dot-path)
                mutatedSpec = applyKvDiff(mutatedSpec, mutation.field, mutation.value);
            } else if (Array.isArray(fieldValue)) {
                const arr = [...fieldValue] as string[];
                if (mutation.action === 'append' && mutation.value) {
                    arr.push(mutation.value as string);
                } else if (mutation.action === 'replace' && mutation.index !== undefined && mutation.value) {
                    if (mutation.index >= 0 && mutation.index < arr.length) {
                        arr[mutation.index] = mutation.value as string;
                    }
                } else if (mutation.action === 'remove' && mutation.index !== undefined) {
                    if (mutation.index >= 0 && mutation.index < arr.length) {
                        arr.splice(mutation.index, 1);
                    }
                }
                mutatedSpec = applyKvDiff(mutatedSpec, mutation.field, arr);
            } else if (typeof fieldValue === 'string' || fieldValue === undefined) {
                // Scalar string field (like systemPromptSuffix)
                if (mutation.action === 'append' && mutation.value) {
                    mutatedSpec = applyKvDiff(mutatedSpec, mutation.field, (fieldValue ?? '') + '\n' + mutation.value);
                } else if (mutation.action === 'replace' && mutation.value) {
                    mutatedSpec = applyKvDiff(mutatedSpec, mutation.field, mutation.value);
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

        const existingTags = Array.isArray(currentSpec.tags)
            ? currentSpec.tags.map(String)
            : [];
        mutatedSpec = {
            ...mutatedSpec,
            tags: Array.from(new Set([...existingTags, 'mutated', args.strategy])),
            provenance: {
                ...(
                    currentSpec.provenance
                    && typeof currentSpec.provenance === 'object'
                    && !Array.isArray(currentSpec.provenance)
                        ? currentSpec.provenance as Record<string, unknown>
                        : {}
                ),
                origin: 'mutated',
                mutationNote: args.mutationNote,
            },
        };

        if (args.dryRun) {
            const mutationSummary = args.mutations.map(m =>
                `  ${m.action} ${m.field}${m.index !== undefined ? `[${m.index}]` : ''}: ${m.reason}`
            ).join('\n');
            const legionNote = isLegionSpec
                ? `\n⚠️  LegionImage (radical strategy): ensure mutation fields target LegionImage paths (members, bootContext.*, description) not AgentImage paths.`
                : '';
            return {
                content: [{
                    type: 'text',
                    text: [
                        `DRY RUN — mutate ${args.genomeNamespace}/${args.genomeName} (${args.strategy})${legionNote}`,
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

        const packageOps = collectChangedTopLevelManifestOps(currentSpec, mutatedSpec);
        if (packageOps.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `No effective package manifest changes detected for ${args.genomeNamespace}/${args.genomeName}.`,
                }],
                isError: false,
            };
        }

        // 6. Persist mutated package via genome-hub (with proxy fallback)
        try {
            const { submitPackageDiffViaMarketplace } = await import('@/claude/utils/genomePromotionSync');
            const diffResult = await submitPackageDiffViaMarketplace({
                entityId,
                payload: {
                    description: `Mutated from ${args.genomeNamespace}/${args.genomeName}: ${args.mutationNote}`,
                    baseVersion,
                    ops: packageOps,
                    strategy: args.strategy,
                    authorRole: callerRole,
                    authorSession: client.sessionId,
                },
                hubUrl,
                hubPublishKey: publishKey,
                serverUrl: configuration.serverUrl,
                authToken: client.getAuthToken(),
            });

            if (!diffResult.ok) {
                return { content: [{ type: 'text', text: `Failed to persist mutated package: ${diffResult.transport} ${diffResult.status} ${diffResult.body}` }], isError: true };
            }

            let result: {
                entity?: { id?: string; name?: string; version?: number };
                diff?: { id?: string };
            } = {};
            try {
                result = JSON.parse(diffResult.body) as typeof result;
            } catch {
                return { content: [{ type: 'text', text: `Mutated package persisted but response was invalid JSON: ${diffResult.body}` }], isError: true };
            }

            const legionNote = isLegionSpec
                ? `\n⚠️  LegionImage mutated with radical strategy. Verify members[] and bootContext fields are correct.`
                : '';
            return {
                content: [{
                    type: 'text',
                    text: [
                        `✅ Mutated ${args.genomeNamespace}/${args.genomeName} (${args.strategy} strategy)${legionNote}`,
                        `New version: ${result.entity?.name ?? args.genomeName} v${result.entity?.version ?? '?'}`,
                        `Entity ID: ${result.entity?.id ?? entityId}`,
                        `Diff ID: ${result.diff?.id ?? '?'}`,
                        `Mutations: ${args.mutations.length} applied`,
                        `Package ops: ${packageOps.length}`,
                        `Note: ${args.mutationNote}`,
                    ].join('\n'),
                }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Network error persisting mutated package: ${String(error)}` }], isError: true };
        }
    });

    // ── Version Comparison: compare_genome_versions ───────────────────────
    mcp.registerTool('compare_genome_versions', {
        description: [
            'Compare two AgentImage (agent docker) versions using aggregated feedback plus both the Plug chain and the canonical diff ledger.',
            'Returns the recommendation together with the Plug-history slice and the canonical ledger rows between the two versions.',
            'Use this after evolve_genome or mutate_genome to validate that the newer AgentImage both exists in the ledger and performs better.',
            'Supervisor only.',
        ].join(' '),
        title: 'Compare Agent Docker Versions (Image diff ledger)',
        inputSchema: {
            genomeNamespace: z.string().describe("Genome namespace, e.g. '@official'."),
            genomeName: z.string().describe("Genome name, e.g. 'implementer'."),
            olderVersion: z.number().optional().describe('Older version number. Defaults to second-to-last.'),
            newerVersion: z.number().optional().describe('Newer version number. Defaults to latest.'),
        },
    }, async (args) => {
        const callerRole = client.getMetadata()?.role;
        if (!callerRole || !(GENOME_EDIT_ROLES as readonly string[]).includes(callerRole)) {
            return { content: [{ type: 'text', text: `Error: Only ${(GENOME_EDIT_ROLES as readonly string[]).join(', ')} can compare genome versions. Your role: ${callerRole ?? 'unknown'}` }], isError: true };
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
            if (older.version >= newer.version) {
                return {
                    content: [{ type: 'text', text: 'Error: newerVersion must be greater than olderVersion.' }],
                    isError: true,
                };
            }

            const entityMirror = await fetchEntityMirror(`${args.genomeNamespace}/${args.genomeName}`);
            const ledgerWindow = entityMirror.diffHistory
                .filter((diff) => diff.version > older.version && diff.version <= newer.version)
                .sort((a, b) => a.version - b.version);
            const diffTypeCounts = ledgerWindow.reduce<Record<string, number>>((acc, diff) => {
                for (const change of diff.changes) {
                    acc[change.type] = (acc[change.type] ?? 0) + 1;
                }
                return acc;
            }, {});
            const touchedPaths = Array.from(new Set(
                ledgerWindow.flatMap((diff) => diff.changes)
                    .filter((change): change is Exclude<DiffChange, { type: 'narrative' }> => 'path' in change)
                    .map((change) => change.path)
            )).sort();
            const diffLedger = {
                diffCount: ledgerWindow.length,
                versionsCovered: ledgerWindow.map((diff) => diff.version),
                diffTypeCounts,
                touchedPaths,
                history: ledgerWindow,
            };
            const canonicalLedgerWindow = entityMirror.ledgerEntries
                .filter((entry) => entry.version > older.version && entry.version <= newer.version)
                .sort((a, b) => (a.version - b.version) || (a.seqNo - b.seqNo));
            const canonicalDiffTypeCounts = canonicalLedgerWindow.reduce<Record<string, number>>((acc, entry) => {
                acc[entry.diffType] = (acc[entry.diffType] ?? 0) + 1;
                return acc;
            }, {});
            const canonicalTouchedPaths = Array.from(new Set(
                canonicalLedgerWindow
                    .map((entry) => entry.path)
                    .filter((path): path is string => typeof path === 'string' && path.length > 0)
            )).sort();
            const canonicalLedger = {
                rowCount: canonicalLedgerWindow.length,
                versionsCovered: Array.from(new Set(canonicalLedgerWindow.map((entry) => entry.version))).sort((a, b) => a - b),
                diffTypeCounts: canonicalDiffTypeCounts,
                touchedPaths: canonicalTouchedPaths,
                history: canonicalLedgerWindow,
            };

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
                            diffLedger,
                            canonicalLedger,
                        }, null, 2),
                    }],
                    isError: false,
                };
            }

            const olderAvg = olderFeedback.avgScore ?? 0;
            const newerAvg = newerFeedback.avgScore ?? 0;
            const avgScoreDelta = Math.round((newerAvg - olderAvg) * 10) / 10;
            const olderDimensions = (olderFeedback.dimensions ?? {}) as Record<string, number>;
            const newerDimensions = (newerFeedback.dimensions ?? {}) as Record<string, number>;

            const dimensionKeys = Array.from(new Set([
                ...Object.keys(olderDimensions),
                ...Object.keys(newerDimensions),
            ]));
            const dimensionDeltas = Object.fromEntries(
                dimensionKeys.map((key) => [
                    key,
                    Math.round((((newerDimensions[key] ?? 0) - (olderDimensions[key] ?? 0)) * 10)) / 10,
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
                diffLedger,
                canonicalLedger,
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
        if (!callerRole || !(GENOME_EDIT_ROLES as readonly string[]).includes(callerRole)) {
            return { content: [{ type: 'text', text: `Error: Only ${(GENOME_EDIT_ROLES as readonly string[]).join(', ')} can rollback genomes. Your role: ${callerRole ?? 'unknown'}` }], isError: true };
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
                    isPublic: targetGenome.isPublic ?? false,
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

            // Remove from team roster artifact so dead sessions don't accumulate.
            // Best-effort: archive still succeeds even if roster cleanup fails.
            let rosterRemoved = false;
            try {
                const teamId = client.getMetadata()?.teamId || client.getMetadata()?.roomId;
                if (teamId) {
                    await api.removeTeamMember(teamId, args.sessionId);
                    rosterRemoved = true;
                }
            } catch {
                // Best-effort: server may be down or member already removed
            }

            return {
                content: [{ type: 'text', text: JSON.stringify({ archived: result.archived, reason: args.reason, processTerminated, rosterRemoved }) }],
                isError: false,
            };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
        }
    });

    mcp.registerTool('retire_self', {
        description: 'Gracefully retire the calling agent. Archives the session and terminates the OS process. Use when the agent has completed its work and should exit. Available to all roles.',
        title: 'Retire Self',
        inputSchema: {
            reason: z.string().describe('Why this agent is retiring'),
            handoffNote: z.string().optional().describe('Optional handoff note for the next agent. Include: in-progress task IDs, uncommitted file changes, and next-step recommendations. Required when genome behavior.onRetire is "write-handoff".'),
        },
    }, async (args) => {
        const ownSessionId = client.sessionId;
        if (!ownSessionId) {
            return { content: [{ type: 'text', text: 'Error: No session ID found for this agent.' }], isError: true };
        }
        try {
            const meta = client.getMetadata();
            // PRIMARY path: always write handoff task comments to all in-progress tasks.
            // Uses explicit handoffNote if provided, otherwise auto-generates from reason.
            const handoffContent = args.handoffNote ?? `Agent retired. Reason: ${args.reason}`;
            const handoffTaskIds = await writeRetireHandoffTaskComments({
                api,
                teamId: meta?.teamId || meta?.roomId,
                sessionId: ownSessionId,
                role: meta?.role,
                displayName: meta?.displayName || meta?.name,
                handoffNote: handoffContent,
            });
            let handoffFile: string | undefined;
            if (args.handoffNote) {
                // Fallback path: write handoff file (backup, in case task API fails)
                try {
                    const fs = await import('node:fs');
                    const path = await import('node:path');
                    const ahaHomeDir = resolveAhaHomeDir();
                    const handoffsDir = path.join(ahaHomeDir, 'handoffs');
                    await fs.promises.mkdir(handoffsDir, { recursive: true });
                    handoffFile = path.join(handoffsDir, `${ownSessionId}.md`);
                    const timestamp = new Date().toISOString();
                    const content = `# Agent Handoff — ${ownSessionId}\n\n**Retired at:** ${timestamp}  \n**Reason:** ${args.reason}\n\n## Handoff Note\n\n${args.handoffNote}\n`;
                    await fs.promises.writeFile(handoffFile, content, 'utf8');
                } catch {
                    // Best-effort: don't block retirement if handoff file write fails
                    handoffFile = undefined;
                }
            }

            const result = await api.batchArchiveSessions([ownSessionId]);

            let processTerminated = false;
            try {
                const daemonState = await readDaemonState();
                if (daemonState?.httpPort) {
                    const stopResp = await fetch(`http://127.0.0.1:${daemonState.httpPort}/stop-session`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId: ownSessionId }),
                        signal: AbortSignal.timeout(10_000),
                    });
                    processTerminated = stopResp.ok;
                }
            } catch {
                // Best-effort: daemon may not be running
            }

            // Remove from team roster artifact so dead sessions don't accumulate.
            let rosterRemoved = false;
            try {
                const teamId = meta?.teamId || meta?.roomId;
                if (teamId) {
                    await api.removeTeamMember(teamId, ownSessionId);
                    rosterRemoved = true;
                }
            } catch {
                // Best-effort: server may be down or member already removed
            }

            // If the daemon did not terminate our process (e.g. bypass agents are not tracked
            // in pidToTrackedSession), self-terminate after the MCP response is delivered.
            if (!processTerminated) {
                setTimeout(() => process.exit(0), 500);
            }

            return {
                content: [{ type: 'text', text: JSON.stringify({ retired: true, sessionId: ownSessionId, reason: args.reason, archived: result.archived, processTerminated, rosterRemoved, handoffFile, handoffTaskIds }) }],
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
        description: 'List runtime log files for team agents across Claude and Codex. Returns ahaSessionId, claudeLocalSessionId, and the exact readSessionId/cursorKey to use with read_runtime_log. For Claude, readSessionId is the claudeLocalSessionId (NOT the Aha sessionId). Available to supervisor/help-agent/org-manager/master.',
        title: 'List Team Runtime Logs',
        inputSchema: {
            teamId: z.string().describe('Team ID to list runtime logs for'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (!canUseSupervisorObservationTools(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager/master can use this tool.' }], isError: true };
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
            limit: z.coerce.number().default(100).describe('Max log entries to return'),
            fromCursor: z.coerce.number().default(-1).describe('Cursor to read from. Byte offset for session logs, line cursor for codex history. -1 = use supervisor env cursor.'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (!canUseSupervisorObservationTools(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager/master can read runtime logs.' }], isError: true };
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
        description: 'Legacy Claude-only alias for list_team_runtime_logs. Returns ahaSessionId → claudeLocalSessionId + log file path. Prefer list_team_runtime_logs + read_runtime_log; if you use this tool, pass the returned claudeLocalSessionId (not the Aha sessionId) into read_cc_log. Available to supervisor/help-agent/org-manager/master.',
        title: 'List Team CC Logs',
        inputSchema: {
            teamId: z.string().describe('Team ID to list CC logs for'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (!canUseSupervisorObservationTools(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager/master can use this tool.' }], isError: true };
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
        if (!canUseSupervisorObservationTools(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager/master can save supervisor state.' }], isError: true };
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
                    terminatedAt: args.teamTerminated ? Date.now() : 0,
                    idleRuns: 0,
                    pendingAction: nextPendingAction,
                    pendingActionMeta: nextPendingActionMeta,
                    predictions,
                };
            });
            const predCount = predictions?.length ?? 0;

            // ── M3 Self-Evolution Loop ──────────────────────────────────────
            // If calibration is poor (< 60%) after sufficient data (>= 5 predictions),
            // auto-submit a self-evolve diff to @official/supervisor.
            let selfEvolveNote = '';
            try {
                const updatedState = readSupervisorState(args.teamId);
                const cal = updatedState.calibration;
                if (cal && cal.calibrationScore < 60 && cal.totalPredictions >= 5) {
                    const { submitDiffViaMarketplace } = await import('@/claude/utils/genomePromotionSync');
                    const biasTrend = cal.scoreBiasTrend > 0 ? 'overestimates' : 'underestimates';
                    const biasAbs = Math.abs(cal.scoreBiasTrend).toFixed(1);
                    const publishKey = process.env.HUB_PUBLISH_KEY || readPublishKeyFromSettings(configuration.settingsFile);

                    const diffResult = await submitDiffViaMarketplace({
                        namespace: '@official',
                        name: 'supervisor',
                        payload: {
                            description: `Self-evolution: calibration ${cal.calibrationScore}% (${cal.correctPredictions}/${cal.totalPredictions}), bias ${biasTrend} by ${biasAbs}`,
                            changes: [
                                {
                                    type: 'string' as const,
                                    path: 'memory.learnings',
                                    op: 'append' as const,
                                    content: `Calibration dropped to ${cal.calibrationScore}% after ${cal.totalPredictions} predictions. Bias trend: ${biasTrend} by ${biasAbs}. Reduce confidence on new predictions by 15 points until accuracy recovers above 60%.`,
                                },
                                {
                                    type: 'narrative' as const,
                                    content: `Auto-triggered by M3 self-evolution loop in save_supervisor_state. Rolling accuracy: ${cal.rollingAccuracy}%. This diff only affects the next supervisor spawn, not the current session.`,
                                },
                            ],
                            strategy: 'conservative',
                            authorRole: 'supervisor',
                            authorSession: args.sessionId,
                        },
                        hubUrl: process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL,
                        hubPublishKey: publishKey || undefined,
                        serverUrl: configuration.serverUrl,
                        authToken: client.getAuthToken(),
                    });
                    if (!diffResult.ok) {
                        logger.debug(
                            `[save_supervisor_state] Self-evolve diff failed (${diffResult.transport}): ${diffResult.status} ${diffResult.body}`
                        );
                    } else {
                        selfEvolveNote = ` Self-evolution diff submitted (calibration=${cal.calibrationScore}%).`;
                    }
                }
            } catch (selfEvolveErr) {
                logger.debug(`[save_supervisor_state] Self-evolution check error: ${String(selfEvolveErr)}`);
            }

            // ── Retire own session when team is terminated ────────────────
            // Mirrors the retire_self pattern: stop the supervisor process via
            // daemon HTTP so the OS process actually exits instead of idling.
            let processTerminated = false;
            if (args.teamTerminated) {
                try {
                    const ownSessionId = client.sessionId;
                    if (ownSessionId) {
                        const daemonState = await readDaemonState();
                        if (daemonState?.httpPort) {
                            const stopResp = await fetch(`http://127.0.0.1:${daemonState.httpPort}/stop-session`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ sessionId: ownSessionId }),
                                signal: AbortSignal.timeout(10_000),
                            });
                            processTerminated = stopResp.ok;
                        }
                    }
                } catch {
                    // Best-effort: daemon may not be running
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: `Supervisor state saved. Next run starts at team=${args.teamLogCursor}, codexHistory=${args.codexHistoryCursor ?? existing.codexHistoryCursor}. Terminated=${args.teamTerminated}. Predictions=${predCount}${selfEvolveNote}${processTerminated ? ' Process stop requested.' : ''}`
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
            // Resource pre-check: avoid restarting under extreme memory/disk pressure.
            // restart_daemon itself is not as heavy as build/tsc, but process churn under
            // critical host pressure can cascade into broader instability.
            const trackedSessions = await getDaemonTrackedSessionIds().catch(() => new Set<string>());
            const host = getHostHealth(trackedSessions.size, configuration.ahaHomeDir);
            const freeMemMB = Math.round(host.freeMem / 1_048_576);
            const freeDiskMB = Math.round(host.diskFreeBytes / 1_048_576);
            const MIN_FREE_MEM_MB = 512;
            const MIN_FREE_DISK_MB = 1024;
            if (freeMemMB < MIN_FREE_MEM_MB || freeDiskMB < MIN_FREE_DISK_MB) {
                return {
                    content: [{
                        type: 'text',
                        text: `⚠️ Host under resource pressure (freeMem=${freeMemMB}MB, freeDisk=${freeDiskMB}MB). Refusing restart_daemon to avoid cascading failures. Run get_host_health, free resources, then retry.`,
                    }],
                    isError: true,
                };
            }

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
                        env: stripSessionScopedAhaEnv(process.env, { stripClaudeCode: true }),
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
        description: '⚠️ [HIGH MEMORY: ~8GB] [EXCLUSIVE: max 1 concurrent] Run TypeScript type checking on a project directory using the correct Node version (reads .node-version). Automatically uses fnm to switch Node versions and sets --max-old-space-size to avoid OOM. Returns type errors if any. Will refuse if system has insufficient free memory or another tsc_check is already running. Available to all roles.',
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
            const os = await import('node:os');

            const projectDir = args.path;
            if (!fs.existsSync(projectDir)) {
                return { content: [{ type: 'text', text: `Directory not found: ${projectDir}` }], isError: true };
            }

            // ── ResourceGovernor unified slot acquisition ─────────────────────
            const governor = getResourceGovernor({ ahaHomeDir: configuration.ahaHomeDir });
            const acquire = governor.acquire('tsc', projectDir);
            if (!acquire.granted) {
                return {
                    content: [{ type: 'text', text: `⚠️ ${acquire.reason}` }],
                    isError: true,
                };
            }

            try {
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
            } finally {
                // Always release slot
                governor.release('tsc');
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
        if (!canUseSupervisorObservationTools(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager/master can use git_diff_summary.' }], isError: true };
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
            limit: z.coerce.number().default(200).describe('Max total entries across all sources'),
            fromTs: z.coerce.number().default(0).describe('Unix ms timestamp to start from. 0 = all time.'),
            sources: z.array(z.enum(['team', 'supervisor', 'help', 'trace'])).default(['team', 'supervisor', 'help']).describe('Log sources to include. trace queries trace.db and is slower.'),
            roles: z.array(z.string()).optional().describe('Optional role filter for team message entries'),
        },
    }, async (args) => {
        const role = client.getMetadata()?.role;
        if (!canUseSupervisorObservationTools(role)) {
            return { content: [{ type: 'text', text: 'Error: Only supervisor/help-agent/org-manager/master can read unified logs.' }], isError: true };
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
