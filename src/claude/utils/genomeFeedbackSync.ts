import type { AggregatedFeedback } from './feedbackPrivacy';
import type { FeedbackUploadTarget } from './supervisorGenomeFeedback';
import { getCanonicalGenomeTargetForRole } from './supervisorGenomeFeedback';

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

async function patchFeedback(
    fetchImpl: FetchLike,
    hubUrl: string,
    hubPublishKey: string | undefined,
    target: FeedbackUploadTarget,
    feedback: AggregatedFeedback,
): Promise<FetchResponseLike> {
    return fetchImpl(
        `${hubUrl}/genomes/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/feedback`,
        {
            method: 'PATCH',
            headers: buildFeedbackHeaders(hubPublishKey),
            body: JSON.stringify(feedback),
            signal: AbortSignal.timeout(15_000),
        },
    );
}

function canAutoCreateOfficialTarget(target: FeedbackUploadTarget, role: string): boolean {
    const canonical = getCanonicalGenomeTargetForRole(role);
    if (!canonical) {
        return false;
    }

    return canonical.namespace === target.namespace && canonical.name === target.name;
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
        isPublic: true,
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
    fetchImpl?: FetchLike;
}): Promise<{
    ok: boolean;
    status: number;
    createdGenome: boolean;
    body: string;
}> {
    const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
    const hubUrl = (args.hubUrl ?? 'http://localhost:3006').replace(/\/$/, '');

    let response = await patchFeedback(fetchImpl, hubUrl, args.hubPublishKey, args.target, args.feedback);
    let body = await response.text().catch(() => '');

    if (response.ok) {
        return {
            ok: true,
            status: response.status,
            createdGenome: false,
            body,
        };
    }

    if (response.status !== 404 || !canAutoCreateOfficialTarget(args.target, args.role)) {
        return {
            ok: false,
            status: response.status,
            createdGenome: false,
            body,
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
        };
    }

    response = await patchFeedback(fetchImpl, hubUrl, args.hubPublishKey, args.target, args.feedback);
    body = await response.text().catch(() => '');
    return {
        ok: response.ok,
        status: response.status,
        createdGenome: true,
        body,
    };
}
