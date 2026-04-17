import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
import type { AggregatedFeedback } from './feedbackPrivacy';
import type { FeedbackUploadTarget } from './supervisorAgentVerdict';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

type FetchResponseLike = {
    ok: boolean;
    status: number;
    text(): Promise<string>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

type RolePlaceholderConfig = {
    displayName: string;
    category: string;
    runtimeType: 'claude' | 'codex' | 'open-code';
    description: string;
    tags: string[];
};

const DEFAULT_ROLE_PLACEHOLDER: RolePlaceholderConfig = {
    displayName: 'Agent',
    category: 'implementation',
    runtimeType: 'claude',
    description: 'Auto-created placeholder genome so supervisor feedback can attach before the canonical genome is seeded.',
    tags: ['feedback-sync', 'auto-created'],
};

const ROLE_PLACEHOLDERS = new Map<string, RolePlaceholderConfig>([
    ['master', {
        displayName: 'Master',
        category: 'coordination',
        runtimeType: 'claude',
        description: 'Auto-created placeholder for the canonical Master genome so supervisor marketplace feedback can be persisted.',
        tags: ['coordination', 'master', 'auto-created'],
    }],
    ['org-manager', {
        displayName: 'Org Manager',
        category: 'coordination',
        runtimeType: 'claude',
        description: 'Auto-created placeholder for the canonical Org Manager genome so supervisor marketplace feedback can be persisted.',
        tags: ['coordination', 'org-manager', 'auto-created'],
    }],
    ['researcher', {
        displayName: 'Researcher',
        category: 'research',
        runtimeType: 'claude',
        description: 'Auto-created placeholder for the canonical Researcher genome so supervisor marketplace feedback can be persisted.',
        tags: ['research', 'researcher', 'auto-created'],
    }],
    ['architect', {
        displayName: 'Architect',
        category: 'implementation',
        runtimeType: 'claude',
        description: 'Auto-created placeholder for the canonical Architect genome so supervisor marketplace feedback can be persisted.',
        tags: ['implementation', 'architect', 'auto-created'],
    }],
    ['implementer', {
        displayName: 'Implementer',
        category: 'implementation',
        runtimeType: 'claude',
        description: 'Auto-created placeholder for the canonical Implementer genome so supervisor marketplace feedback can be persisted.',
        tags: ['implementation', 'implementer', 'auto-created'],
    }],
    ['qa-engineer', {
        displayName: 'QA Engineer',
        category: 'review',
        runtimeType: 'claude',
        description: 'Auto-created placeholder for the canonical QA Engineer genome so supervisor marketplace feedback can be persisted.',
        tags: ['review', 'qa-engineer', 'auto-created'],
    }],
    ['supervisor', {
        displayName: 'Supervisor',
        category: 'coordination',
        runtimeType: 'claude',
        description: 'Auto-created placeholder for the canonical Supervisor genome so supervisor marketplace feedback can be persisted.',
        tags: ['bypass', 'supervisor', 'auto-created'],
    }],
    ['help-agent', {
        displayName: 'Help Agent',
        category: 'support',
        runtimeType: 'claude',
        description: 'Auto-created placeholder for the canonical Help Agent genome so supervisor marketplace feedback can be persisted.',
        tags: ['bypass', 'help-agent', 'auto-created'],
    }],
]);

function normalizeRole(role: string): string {
    return role
        .trim()
        .toLowerCase()
        .replace(/\s*\(.*?\)\s*/g, ' ')
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function buildFeedbackHeaders(hubPublishKey?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(hubPublishKey ? { 'Authorization': `Bearer ${hubPublishKey}` } : {}),
    };
}

function buildServerProxyHeaders(authToken?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
    };
}

function buildFeedbackUrl(hubUrl: string, target: FeedbackUploadTarget): string {
    if (target.genomeId) {
        return `${hubUrl}/genomes/id/${encodeURIComponent(target.genomeId)}/feedback`;
    }
    if (target.version != null) {
        return `${hubUrl}/genomes/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/versions/${target.version}/feedback`;
    }
    return `${hubUrl}/genomes/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/feedback`;
}

async function patchFeedback(
    fetchImpl: FetchLike,
    hubUrl: string,
    hubPublishKey: string | undefined,
    target: FeedbackUploadTarget,
    feedback: AggregatedFeedback,
): Promise<FetchResponseLike> {
    return fetchImpl(
        buildFeedbackUrl(hubUrl, target),
        {
            method: 'PATCH',
            headers: buildFeedbackHeaders(hubPublishKey),
            body: JSON.stringify(feedback),
            signal: AbortSignal.timeout(15_000),
        },
    );
}

function buildFeedbackProxyUrl(serverUrl: string, target: FeedbackUploadTarget): string {
    if (target.genomeId) {
        return `${serverUrl}/v1/genomes/id/${encodeURIComponent(target.genomeId)}/feedback`;
    }
    if (target.version != null) {
        return `${serverUrl}/v1/genomes/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/versions/${target.version}/feedback`;
    }
    return `${serverUrl}/v1/genomes/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/feedback`;
}

async function patchFeedbackViaServerProxy(
    fetchImpl: FetchLike,
    serverUrl: string,
    authToken: string | undefined,
    target: FeedbackUploadTarget,
    feedback: AggregatedFeedback,
): Promise<FetchResponseLike> {
    return fetchImpl(
        buildFeedbackProxyUrl(serverUrl, target),
        {
            method: 'PATCH',
            headers: buildServerProxyHeaders(authToken),
            body: JSON.stringify(feedback),
            signal: AbortSignal.timeout(15_000),
        },
    );
}

export function normalizeFeedbackProxyBaseUrl(serverUrl: string): string {
    try {
        // configuration.serverUrl may point at an API-prefixed base such as
        // https://aha-agi.com/api, but the feedback proxy route lives at
        // the site origin under /v1/genomes/...
        return new URL(serverUrl).origin.replace(/\/$/, '');
    } catch {
        return serverUrl
            .replace(/\/api\/v\d+\/?$/i, '')
            .replace(/\/$/, '');
    }
}

function canAutoCreateOfficialTarget(target: FeedbackUploadTarget): boolean {
    if (target.namespace !== '@official' || target.genomeId) {
        return false;
    }

    return ROLE_PLACEHOLDERS.has(target.name);
}

function buildPlaceholderGenomeBody(target: FeedbackUploadTarget, role: string): string {
    const normalizedRole = normalizeRole(role);
    const config = ROLE_PLACEHOLDERS.get(target.name)
        ?? ROLE_PLACEHOLDERS.get(normalizedRole)
        ?? DEFAULT_ROLE_PLACEHOLDER;

    return JSON.stringify({
        namespace: target.namespace,
        name: target.name,
        version: 1,
        description: config.description,
        spec: JSON.stringify({
            displayName: config.displayName,
            runtimeType: config.runtimeType,
            lifecycle: 'active',
            namespace: target.namespace,
            version: 1,
            baseRoleId: target.name,
            description: config.description,
            tags: config.tags,
            category: config.category,
            responsibilities: [
                'Serve as the canonical marketplace anchor for supervisor-generated aggregate feedback.',
            ],
        }),
        tags: JSON.stringify(config.tags),
        category: config.category,
        isPublic: false,
    });
}

async function createPlaceholderGenome(
    fetchImpl: FetchLike,
    hubUrl: string,
    hubPublishKey: string | undefined,
    target: FeedbackUploadTarget,
    role: string,
): Promise<FetchResponseLike> {
    return fetchImpl(`${hubUrl}/genomes`, {
        method: 'POST',
        headers: buildFeedbackHeaders(hubPublishKey),
        body: buildPlaceholderGenomeBody(target, role),
        signal: AbortSignal.timeout(15_000),
    });
}

export async function syncGenomeFeedbackToMarketplace(args: {
    target: FeedbackUploadTarget;
    role: string;
    feedback: AggregatedFeedback;
    hubUrl?: string;
    hubPublishKey?: string;
    serverUrl?: string;
    authToken?: string;
    fetchImpl?: FetchLike;
}): Promise<{
    ok: boolean;
    status: number;
    createdGenome: boolean;
    body: string;
    transport: 'direct-hub' | 'server-proxy';
}> {
    const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
    if (!args.hubUrl && !process.env.GENOME_HUB_URL) {
        logger.warn(`[genome-feedback] GENOME_HUB_URL not set, falling back to ${DEFAULT_GENOME_HUB_URL}`);
    }
    const hubUrl = (args.hubUrl ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const rawServerUrl = args.serverUrl ?? configuration.serverUrl;
    const serverUrl = normalizeFeedbackProxyBaseUrl(rawServerUrl);
    if (serverUrl !== rawServerUrl.replace(/\/$/, '')) {
        logger.warn(`[genome-feedback] serverUrl has path prefix ("${rawServerUrl}"), normalized to origin "${serverUrl}" for feedback proxy`);
    }

    let response: FetchResponseLike | null = null;
    let body = '';
    let directError: unknown = null;

    try {
        response = await patchFeedback(fetchImpl, hubUrl, args.hubPublishKey, args.target, args.feedback);
        body = await response.text().catch(() => '');
    } catch (error) {
        directError = error;
    }

    const shouldTryServerProxy = Boolean(args.authToken) && (
        directError
        || !response
        || response.status === 401
        || response.status === 403
        || response.status === 405
        || response.status >= 500
    );

    if (shouldTryServerProxy) {
        try {
            const proxiedResponse = await patchFeedbackViaServerProxy(
                fetchImpl,
                serverUrl,
                args.authToken,
                args.target,
                args.feedback,
            );
            const proxiedBody = await proxiedResponse.text().catch(() => '');

            if (proxiedResponse.ok) {
                return {
                    ok: true,
                    status: proxiedResponse.status,
                    createdGenome: false,
                    body: proxiedBody,
                    transport: 'server-proxy',
                };
            }

            response = proxiedResponse;
            body = proxiedBody;
        } catch (proxyError) {
            if (!response) {
                return {
                    ok: false,
                    status: 0,
                    createdGenome: false,
                    body: String(proxyError || directError || 'Unknown network error'),
                    transport: 'server-proxy',
                };
            }
        }
    }

    if (response?.ok) {
        return {
            ok: true,
            status: response.status,
            createdGenome: false,
            body,
            transport: 'direct-hub',
        };
    }

    if (!response) {
        return {
            ok: false,
            status: 0,
            createdGenome: false,
            body: String(directError || 'Unknown network error'),
            transport: 'direct-hub',
        };
    }

    if (response.status !== 404 || !canAutoCreateOfficialTarget(args.target)) {
        return {
            ok: false,
            status: response.status,
            createdGenome: false,
            body,
            transport: 'direct-hub',
        };
    }

    const createResponse = await createPlaceholderGenome(fetchImpl, hubUrl, args.hubPublishKey, args.target, args.role);
    const createBody = await createResponse.text().catch(() => '');
    if (!createResponse.ok) {
        return {
            ok: false,
            status: createResponse.status,
            createdGenome: false,
            body: createBody || body,
            transport: 'direct-hub',
        };
    }

    response = await patchFeedback(fetchImpl, hubUrl, args.hubPublishKey, args.target, args.feedback);
    body = await response.text().catch(() => '');
    return {
        ok: response.ok,
        status: response.status,
        createdGenome: true,
        body,
        transport: 'direct-hub',
    };
}
