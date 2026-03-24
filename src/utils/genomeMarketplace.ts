import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
import type { CorpsSpec } from '@/api/types/genome';
import { logger } from '@/ui/logger';
import { buildMarketplaceConnectionHint } from './marketplaceConnection';

export type MarketplaceGenomeRecord = {
    id: string;
    namespace: string | null;
    name: string;
    version?: number | null;
    description?: string | null;
    spec?: string | null;
    tags?: string | null;
    category?: string | null;
    spawnCount?: number | null;
    feedbackData?: string | null;
};

export type MarketplaceFeedbackSummary = {
    avgScore: number;
    evaluationCount: number;
};

export type ResolvedGenomeSelection = {
    specId: string | null;
    source: 'explicit' | 'best-rated' | 'official' | 'none';
    matchedName?: string;
};

export type CorpsTemplateMember = {
    genome: string;
    roleAlias?: string;
    required?: boolean;
    overlay?: {
        promptSuffix?: string;
        messaging?: Record<string, unknown>;
        behavior?: Record<string, unknown>;
        authorities?: string[];
    };
};

type PublishTeamCorpsTemplateOptions = {
    api: {
        getTeam(teamId: string): Promise<{ team?: { id: string; name?: string; members?: any[] } } | null>;
        getArtifact(teamId: string): Promise<any>;
    };
    teamId: string;
    publisherId?: string;
    hubUrl?: string;
    publishKey?: string;
    namespace?: string;
};

const ROLE_MARKET_ALIASES: Record<string, string[]> = {
    builder: ['implementer'],
    implementer: [],
    framer: ['architect'],
    architect: [],
    'solution-architect': ['architect'],
    reviewer: ['qa-engineer'],
    qa: ['qa-engineer'],
    'qa-engineer': [],
    scout: ['researcher'],
    researcher: [],
    'ux-researcher': ['researcher'],
    'business-analyst': ['researcher'],
    orchestrator: ['master'],
    'project-manager': ['master'],
    'product-owner': ['master'],
    'help-agent': [],
    supervisor: [],
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of values) {
        const trimmed = value?.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }

    return result;
}

function parseJsonArray(value?: string | null): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
        return [];
    }
}

function stableStringify(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value);
}

export function parseMarketplaceFeedbackData(feedbackData?: string | null): MarketplaceFeedbackSummary {
    if (!feedbackData) {
        return { avgScore: 0, evaluationCount: 0 };
    }

    try {
        const parsed = JSON.parse(feedbackData) as { avgScore?: number; evaluationCount?: number };
        return {
            avgScore: typeof parsed.avgScore === 'number' ? parsed.avgScore : 0,
            evaluationCount: typeof parsed.evaluationCount === 'number' ? parsed.evaluationCount : 0,
        };
    } catch {
        return { avgScore: 0, evaluationCount: 0 };
    }
}

export function getPreferredGenomeNames(role: string, runtime: 'claude' | 'codex'): string[] {
    const normalizedRole = role.trim();
    const aliases = ROLE_MARKET_ALIASES[normalizedRole] ?? [];

    return uniqueStrings([
        runtime === 'codex' && normalizedRole === 'agent-builder' ? 'agent-builder-codex' : normalizedRole,
        normalizedRole,
        ...aliases,
    ]);
}

export function searchMatchesRole(genome: MarketplaceGenomeRecord, roleNames: string[]): boolean {
    const normalizedName = genome.name.toLowerCase();
    const tagSet = parseJsonArray(genome.tags).map((tag) => tag.toLowerCase());

    return roleNames.some((roleName) => {
        const normalizedRole = roleName.toLowerCase();
        return normalizedName === normalizedRole
            || tagSet.includes(normalizedRole);
    });
}

export function selectBestRatedGenomeCandidate(
    genomes: MarketplaceGenomeRecord[],
    roleNames: string[],
    options?: { minScore?: number; minEvaluationCount?: number }
): MarketplaceGenomeRecord | null {
    const minScore = options?.minScore ?? 60;
    const minEvaluationCount = options?.minEvaluationCount ?? 3;

    const candidates = genomes
        .filter((genome) => searchMatchesRole(genome, roleNames))
        .filter((genome) => {
            const feedback = parseMarketplaceFeedbackData(genome.feedbackData);
            return feedback.avgScore >= minScore && feedback.evaluationCount >= minEvaluationCount;
        });

    if (candidates.length === 0) return null;

    return candidates.sort((left, right) => {
        const leftFeedback = parseMarketplaceFeedbackData(left.feedbackData);
        const rightFeedback = parseMarketplaceFeedbackData(right.feedbackData);
        const leftExact = Number(roleNames.some((roleName) => left.name.toLowerCase() === roleName.toLowerCase()));
        const rightExact = Number(roleNames.some((roleName) => right.name.toLowerCase() === roleName.toLowerCase()));

        return (
            rightFeedback.avgScore - leftFeedback.avgScore ||
            rightFeedback.evaluationCount - leftFeedback.evaluationCount ||
            (right.spawnCount ?? 0) - (left.spawnCount ?? 0) ||
            rightExact - leftExact
        );
    })[0];
}

export async function searchMarketplaceGenomes(options?: {
    query?: string;
    category?: string;
    limit?: number;
    hubUrl?: string;
}): Promise<MarketplaceGenomeRecord[]> {
    const hubUrl = (options?.hubUrl ?? process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const query = new URLSearchParams();

    if (options?.query) query.set('q', options.query);
    if (options?.category) query.set('category', options.category);
    query.set('sortBy', 'score');
    query.set('limit', String(options?.limit ?? 20));

    let response: Response;
    try {
        response = await fetch(`${hubUrl}/genomes?${query.toString()}`, {
            signal: AbortSignal.timeout(5_000),
        });
    } catch (error) {
        throw new Error(`${String(error)}. ${buildMarketplaceConnectionHint(hubUrl)}`);
    }

    if (!response.ok) {
        throw new Error(`genome-hub returned ${response.status}`);
    }

    const payload = await response.json() as { genomes?: MarketplaceGenomeRecord[] };
    return payload.genomes ?? [];
}

function resolveMarketplaceGenomeUrls(specId: string, hubUrl?: string): string[] {
    const baseUrl = (hubUrl ?? process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const nsMatch = specId.match(/^(@[^/]+)\/([^:]+)(?::(\d+))?$/);

    if (nsMatch) {
        const [, ns, name, version] = nsMatch;
        const encodedNs = encodeURIComponent(ns);
        return version
            ? [`${baseUrl}/genomes/${encodedNs}/${name}/${version}`]
            : [`${baseUrl}/genomes/${encodedNs}/${name}`];
    }

    return [`${baseUrl}/genomes/id/${encodeURIComponent(specId)}`];
}

export async function fetchMarketplaceGenomeDetail(specId: string, hubUrl?: string): Promise<MarketplaceGenomeRecord | null> {
    for (const url of resolveMarketplaceGenomeUrls(specId, hubUrl)) {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(5_000),
        });

        if (!response.ok) {
            continue;
        }

        const payload = await response.json() as { genome?: MarketplaceGenomeRecord };
        if (payload.genome) {
            return payload.genome;
        }
    }

    return null;
}

export async function fetchGenomeRecordById(specId: string, hubUrl?: string): Promise<MarketplaceGenomeRecord | null> {
    return fetchMarketplaceGenomeDetail(specId, hubUrl);
}

export function formatMarketplaceGenomeRef(
    genome: Pick<MarketplaceGenomeRecord, 'namespace' | 'name' | 'version'>,
    options?: { pinVersion?: boolean },
): string | null {
    if (!genome.namespace || !genome.name) return null;
    if (options?.pinVersion && typeof genome.version === 'number') {
        return `${genome.namespace}/${genome.name}:${genome.version}`;
    }
    return `${genome.namespace}/${genome.name}`;
}

export function parseCorpsSpecFromGenome(genome: Pick<MarketplaceGenomeRecord, 'name' | 'category' | 'spec'>): CorpsSpec {
    if (!genome.spec) {
        throw new Error(`Marketplace record "${genome.name}" has no spec payload.`);
    }

    const parsed = JSON.parse(genome.spec) as CorpsSpec;
    if (!parsed || !Array.isArray(parsed.members)) {
        throw new Error(`Marketplace record "${genome.name}" is not a valid CorpsSpec team template.`);
    }

    if (genome.category && genome.category !== 'corps') {
        throw new Error(`Marketplace record "${genome.name}" is category "${genome.category}", not a corps/team template.`);
    }

    return parsed;
}

export function deriveRoleIdFromGenomeRef(genomeRef: string): string {
    const match = genomeRef.match(/^@[^/]+\/([^:]+)(?::\d+)?$/);
    return match?.[1] || 'member';
}

export async function resolveOfficialGenomeSpecId(
    role: string,
    runtime: 'claude' | 'codex',
    hubUrl?: string
): Promise<{ specId: string | null; matchedName?: string }> {
    const baseUrl = (hubUrl ?? process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');

    for (const officialName of getPreferredGenomeNames(role, runtime)) {
        try {
            const response = await fetch(
                `${baseUrl}/genomes/%40official/${encodeURIComponent(officialName)}`,
                { signal: AbortSignal.timeout(3_000) }
            );

            if (!response.ok) continue;
            const payload = await response.json() as { genome?: { id?: string } };
            if (payload.genome?.id) {
                return { specId: payload.genome.id, matchedName: officialName };
            }
        } catch {
            // Ignore and continue to the next fallback name.
        }
    }

    return { specId: null };
}

export async function resolvePreferredGenomeSpecId(options: {
    role: string;
    runtime: 'claude' | 'codex';
    strategy?: 'official' | 'best-rated';
    explicitSpecId?: string;
    hubUrl?: string;
}): Promise<ResolvedGenomeSelection> {
    if (options.explicitSpecId) {
        return { specId: options.explicitSpecId, source: 'explicit' };
    }

    const preferredNames = getPreferredGenomeNames(options.role, options.runtime);
    const strategy = options.strategy ?? 'best-rated';

    if (strategy !== 'official') {
        const marketCandidates: MarketplaceGenomeRecord[] = [];

        for (const queryName of preferredNames) {
            try {
                const genomes = await searchMarketplaceGenomes({
                    query: queryName,
                    limit: 8,
                    hubUrl: options.hubUrl,
                });
                marketCandidates.push(...genomes);
            } catch (error) {
                logger.debug(`[genome-marketplace] best-rated lookup failed for ${queryName}: ${String(error)}`);
            }
        }

        const selected = selectBestRatedGenomeCandidate(marketCandidates, preferredNames);
        if (selected?.id) {
            return { specId: selected.id, source: 'best-rated', matchedName: selected.name };
        }
    }

    const official = await resolveOfficialGenomeSpecId(options.role, options.runtime, options.hubUrl);
    if (official.specId) {
        return { specId: official.specId, source: 'official', matchedName: official.matchedName };
    }

    return { specId: null, source: 'none' };
}

export function slugifyMarketplaceName(input: string): string {
    const collapsed = input
        .trim()
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '');

    return collapsed || 'team-template';
}

function extractArtifactBoard(artifact: any): any {
    if (!artifact?.body) return null;
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

    return artifact.body;
}

export function buildPublishedCorpsSpec(options: {
    namespace?: string;
    name: string;
    description: string;
    teamDescription?: string;
    initialObjective?: string;
    sharedContext?: string[];
    commandChain?: string[];
    taskPolicy?: Record<string, unknown>;
    tags?: string[];
    members: CorpsTemplateMember[];
}): CorpsSpec {
    const aggregated = new Map<string, CorpsSpec['members'][number]>();

    for (const member of options.members) {
        const key = `${member.genome}::${member.roleAlias || ''}::${member.required !== false}::${stableStringify(member.overlay ?? null)}`;
        const existing = aggregated.get(key);
        if (existing) {
            existing.count = (existing.count ?? 1) + 1;
            continue;
        }

        aggregated.set(key, {
            genome: member.genome,
            roleAlias: member.roleAlias,
            required: member.required !== false,
            count: 1,
            ...(member.overlay ? { overlay: member.overlay } : {}),
        });
    }

    return {
        namespace: options.namespace ?? '@public',
        name: options.name,
        version: 1,
        description: options.description,
        tags: uniqueStrings(['corps', 'auto-published', ...(options.tags ?? [])]),
        category: 'corps',
        members: Array.from(aggregated.values()),
        bootContext: {
            teamDescription: options.teamDescription ?? options.description,
            ...(options.initialObjective ? { initialObjective: options.initialObjective } : {}),
            ...(options.sharedContext ? { sharedContext: options.sharedContext } : {}),
            ...(options.commandChain ? { commandChain: options.commandChain } : {}),
            ...(options.taskPolicy ? { taskPolicy: options.taskPolicy } : {}),
        },
    };
}

function deriveInitialObjective(board: any): string | undefined {
    const bootObjective = board?.team?.bootContext?.initialObjective?.trim();
    if (bootObjective) return bootObjective;

    const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
    const goalTask = tasks.find((task: any) => typeof task?.title === 'string' && task.title.includes('Team Goal'));
    if (goalTask?.title) {
        return String(goalTask.title).replace(/^🎯\s*Team Goal:\s*/u, '').trim();
    }

    return undefined;
}

export async function publishTeamCorpsTemplate(options: PublishTeamCorpsTemplateOptions): Promise<{
    published: boolean;
    templateName?: string;
    templateId?: string;
    error?: string;
}> {
    const hubUrl = (options.hubUrl ?? process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const publishKey = options.publishKey ?? process.env.HUB_PUBLISH_KEY ?? '';

    try {
        const teamResult = await options.api.getTeam(options.teamId);
        const team = teamResult?.team;
        const members = Array.isArray(team?.members) ? team!.members : [];
        if (!team || members.length === 0) {
            return { published: false, error: 'No team members available for corps publishing.' };
        }

        let board: any = null;
        try {
            const artifact = await options.api.getArtifact(options.teamId);
            board = extractArtifactBoard(artifact);
        } catch (error) {
            logger.debug(`[genome-marketplace] Failed to load team artifact for corps publish: ${String(error)}`);
        }

        const publishedMembers: CorpsTemplateMember[] = [];
        for (const member of members) {
            const roleId = member?.roleId || member?.role || 'member';
            const runtime = member?.runtimeType === 'codex' ? 'codex' : 'claude';
            let genomeRef: string | null = null;

            if (member?.specId) {
                const genome = await fetchGenomeRecordById(String(member.specId), hubUrl);
                const pinnedRef = genome ? formatMarketplaceGenomeRef(genome, { pinVersion: true }) : null;
                if (pinnedRef) {
                    genomeRef = pinnedRef;
                }
            }

            if (!genomeRef) {
                const [fallbackName] = getPreferredGenomeNames(roleId, runtime);
                if (fallbackName) {
                    genomeRef = `@official/${fallbackName}`;
                }
            }

            if (!genomeRef) continue;

            publishedMembers.push({
                genome: genomeRef,
                roleAlias: roleId,
                required: member?.executionPlane !== 'bypass',
                ...(member?.teamOverlay ? { overlay: member.teamOverlay } : {}),
            });
        }

        if (publishedMembers.length === 0) {
            return { published: false, error: 'No publishable genome refs could be resolved for the team.' };
        }

        const teamName = (team.name || options.teamId).trim();
        const templateName = `${slugifyMarketplaceName(teamName)}-${options.teamId.slice(0, 8)}`;
        const roleTags = uniqueStrings(publishedMembers.map((member) => member.roleAlias));
        const corps = buildPublishedCorpsSpec({
            namespace: options.namespace ?? '@public',
            name: templateName,
            description: `Auto-published corps template for ${teamName}`,
            teamDescription: board?.team?.bootContext?.teamDescription?.trim() || `${teamName} team template`,
            initialObjective: deriveInitialObjective(board),
            sharedContext: Array.isArray(board?.team?.bootContext?.sharedContext) ? board.team.bootContext.sharedContext : undefined,
            commandChain: Array.isArray(board?.team?.bootContext?.commandChain) ? board.team.bootContext.commandChain : undefined,
            taskPolicy: board?.team?.bootContext?.taskPolicy && typeof board.team.bootContext.taskPolicy === 'object'
                ? board.team.bootContext.taskPolicy
                : undefined,
            tags: roleTags,
            members: publishedMembers,
        });

        const response = await fetch(`${hubUrl}/corps`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(publishKey ? { Authorization: `Bearer ${publishKey}` } : {}),
            },
            body: JSON.stringify({
                namespace: corps.namespace,
                name: corps.name,
                version: corps.version,
                description: corps.description,
                spec: JSON.stringify(corps),
                tags: corps.tags,
                isPublic: true,
                publisherId: options.publisherId ?? null,
            }),
            signal: AbortSignal.timeout(8_000),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return { published: false, error: `corps publish failed: ${response.status} ${errorBody}` };
        }

        const payload = await response.json() as { genome?: { id?: string } };
        return {
            published: true,
            templateName,
            templateId: payload.genome?.id,
        };
    } catch (error) {
        return { published: false, error: String(error) };
    }
}
