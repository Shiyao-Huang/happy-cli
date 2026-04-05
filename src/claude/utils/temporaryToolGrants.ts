import type { Metadata } from '@/api/types';
import type { AgentImage } from '@/api/types/genome';
import { configuration } from '@/configuration';
import { DEFAULT_GENOME_HUB_URL, readPublishKeyFromSettings } from '@/configurationResolver';

type FetchResponseLike = {
    ok: boolean;
    status: number;
    text(): Promise<string>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

export const DYNAMIC_TOOL_GRANT_OPT_IN_TOKEN = '@granted';
export const DEFAULT_DYNAMIC_TOOL_GRANT_TTL_MINUTES = 30;

const HARD_DENIED_DYNAMIC_TOOL_NAMES = [
    'delete_file',
    'write_to_file',
    'replace_file_content',
    'move_file',
    'edit',
    'write',
    'multiedit',
    'kill_agent',
    'archive_session',
    'retire_self',
    'delete_task',
];

export interface TemporaryToolGrantRecord {
    id: string;
    sessionId: string;
    tool: string;
    grantedBy: string;
    grantedByRole?: string | null;
    reason: string;
    taskId?: string | null;
    expiresAt: string;
    revokedAt?: string | null;
    revokedBy?: string | null;
    createdAt?: string;
    updatedAt?: string;
}

function uniqueToolNames(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed) continue;
        const key = normalizeGrantedToolName(trimmed).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(trimmed);
    }
    return result;
}

export function normalizeGrantedToolName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    const mcpMatch = trimmed.match(/^mcp__.+?__(.+)$/);
    return (mcpMatch?.[1] ?? trimmed).trim();
}

export function isHardDeniedDynamicGrantTool(tool: string): boolean {
    const normalized = normalizeGrantedToolName(tool).toLowerCase();
    return HARD_DENIED_DYNAMIC_TOOL_NAMES.includes(normalized);
}

export function hasDynamicGrantOptIn(agentImage?: AgentImage | null): boolean {
    const fields = [
        ...(agentImage?.tags ?? []),
        ...(agentImage?.capabilities ?? []),
        ...(agentImage?.skills ?? []),
        ...(agentImage?.responsibilities ?? []),
        ...(agentImage?.protocol ?? []),
    ];
    return fields.some((value) => typeof value === 'string' && value.trim() === DYNAMIC_TOOL_GRANT_OPT_IN_TOKEN);
}

function parseGrantExpiry(value: string | undefined | null): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function listActiveTemporaryGrantToolsFromMetadata(
    metadata?: Pick<Metadata, 'temporaryToolGrants'> | null,
    nowMs: number = Date.now(),
): TemporaryToolGrantRecord[] {
    const grants = Array.isArray(metadata?.temporaryToolGrants)
        ? metadata.temporaryToolGrants
        : [];

    return grants.filter((grant): grant is TemporaryToolGrantRecord => {
        if (!grant || typeof grant !== 'object') return false;
        if (typeof grant.tool !== 'string' || typeof grant.id !== 'string' || typeof grant.grantedBy !== 'string') return false;
        if (grant.revokedAt) return false;
        const expiresAtMs = parseGrantExpiry(grant.expiresAt);
        if (expiresAtMs == null || expiresAtMs <= nowMs) return false;
        return !isHardDeniedDynamicGrantTool(grant.tool);
    });
}

export function computeEffectiveAllowedToolsFromMetadata(args: {
    baseAllowedTools?: string[] | null;
    baseDisallowedTools?: string[] | null;
    metadata?: Pick<Metadata, 'temporaryToolGrants'> | null;
    dynamicGrantOptIn?: boolean;
    nowMs?: number;
}): {
    allowedTools: string[] | undefined;
    disallowedTools: string[] | undefined;
    activeGrantTools: string[];
} {
    const disallowedTools = uniqueToolNames(args.baseDisallowedTools ?? []);
    const disallowedSet = new Set(disallowedTools.map((tool) => normalizeGrantedToolName(tool).toLowerCase()));

    const activeGrantTools = args.dynamicGrantOptIn
        ? uniqueToolNames(
            listActiveTemporaryGrantToolsFromMetadata(args.metadata, args.nowMs).map((grant) => grant.tool),
        ).filter((tool) => !disallowedSet.has(normalizeGrantedToolName(tool).toLowerCase()))
        : [];

    const baseAllowedTools = Array.isArray(args.baseAllowedTools)
        ? uniqueToolNames(args.baseAllowedTools)
        : undefined;

    if (!baseAllowedTools) {
        return {
            allowedTools: undefined,
            disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
            activeGrantTools,
        };
    }

    const merged = uniqueToolNames([...baseAllowedTools, ...activeGrantTools]).filter(
        (tool) => !disallowedSet.has(normalizeGrantedToolName(tool).toLowerCase()),
    );

    return {
        allowedTools: merged,
        disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
        activeGrantTools,
    };
}

function buildHubHeaders(hubPublishKey?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(hubPublishKey ? { Authorization: `Bearer ${hubPublishKey}` } : {}),
    };
}

function resolveHubPublishKey(explicit?: string): string | undefined {
    return explicit || process.env.HUB_PUBLISH_KEY || readPublishKeyFromSettings(configuration.settingsFile) || undefined;
}

function parseGrantResponseBody(raw: string): any {
    try {
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

export async function listTemporaryToolGrants(args: {
    sessionId: string;
    activeOnly?: boolean;
    hubUrl?: string;
    hubPublishKey?: string;
    fetchImpl?: FetchLike;
}): Promise<{
    ok: boolean;
    status: number;
    grants: TemporaryToolGrantRecord[];
    body: string;
}> {
    const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
    const hubUrl = (args.hubUrl ?? process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const hubPublishKey = resolveHubPublishKey(args.hubPublishKey);
    const query = new URLSearchParams({
        sessionId: args.sessionId,
        activeOnly: String(args.activeOnly ?? true),
    });
    const response = await fetchImpl(`${hubUrl}/permissions?${query.toString()}`, {
        method: 'GET',
        headers: buildHubHeaders(hubPublishKey),
        signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text().catch(() => '');
    const parsed = parseGrantResponseBody(body);
    return {
        ok: response.ok,
        status: response.status,
        grants: Array.isArray(parsed.grants) ? parsed.grants : [],
        body,
    };
}

export async function grantTemporaryToolAccess(args: {
    sessionId: string;
    tool: string;
    grantedBy: string;
    grantedByRole?: string | null;
    reason: string;
    taskId?: string | null;
    expiresAt: string;
    hubUrl?: string;
    hubPublishKey?: string;
    fetchImpl?: FetchLike;
}): Promise<{
    ok: boolean;
    status: number;
    grant: TemporaryToolGrantRecord | null;
    replacedGrantIds: string[];
    body: string;
}> {
    const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
    const hubUrl = (args.hubUrl ?? process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const hubPublishKey = resolveHubPublishKey(args.hubPublishKey);
    const response = await fetchImpl(`${hubUrl}/permissions/grant`, {
        method: 'POST',
        headers: buildHubHeaders(hubPublishKey),
        body: JSON.stringify({
            sessionId: args.sessionId,
            tool: normalizeGrantedToolName(args.tool),
            grantedBy: args.grantedBy,
            grantedByRole: args.grantedByRole ?? undefined,
            reason: args.reason,
            taskId: args.taskId ?? undefined,
            expiresAt: args.expiresAt,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text().catch(() => '');
    const parsed = parseGrantResponseBody(body);
    return {
        ok: response.ok,
        status: response.status,
        grant: parsed.grant ?? null,
        replacedGrantIds: Array.isArray(parsed.replacedGrantIds) ? parsed.replacedGrantIds : [],
        body,
    };
}

export async function revokeTemporaryToolAccess(args: {
    grantId: string;
    revokedBy: string;
    hubUrl?: string;
    hubPublishKey?: string;
    fetchImpl?: FetchLike;
}): Promise<{
    ok: boolean;
    status: number;
    grant: TemporaryToolGrantRecord | null;
    body: string;
}> {
    const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
    const hubUrl = (args.hubUrl ?? process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const hubPublishKey = resolveHubPublishKey(args.hubPublishKey);
    const response = await fetchImpl(`${hubUrl}/permissions/${encodeURIComponent(args.grantId)}`, {
        method: 'DELETE',
        headers: buildHubHeaders(hubPublishKey),
        body: JSON.stringify({
            revokedBy: args.revokedBy,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text().catch(() => '');
    const parsed = parseGrantResponseBody(body);
    return {
        ok: response.ok,
        status: response.status,
        grant: parsed.grant ?? null,
        body,
    };
}
