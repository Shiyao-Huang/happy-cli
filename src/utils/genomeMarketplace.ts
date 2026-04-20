import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
import type { LegionImage } from '@/api/types/genome';
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
    runtimeType?: 'claude' | 'codex' | 'open-code' | null;
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
    overlay?: LegionImage['members'][number]['overlay'];
};

class MarketplaceRateLimitedError extends Error {
    constructor() {
        super('marketplace_rate_limited');
        this.name = 'MarketplaceRateLimitedError';
    }
}

type MarketplaceCacheEntry<T> = {
    expiresAt: number;
    promise: Promise<T>;
    resolved?: T;
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
    /** Whether the published corps is publicly visible in the marketplace. Defaults to false. */
    isPublic?: boolean;
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

const MARKETPLACE_SUCCESS_TTL_MS = 60_000;
const MARKETPLACE_MISS_TTL_MS = 15_000;
const MARKETPLACE_RATE_LIMIT_COOLDOWN_MS = 15_000;

const marketplacePageCache = new Map<string, MarketplaceCacheEntry<MarketplaceGenomeRecord[]>>();
const marketplaceDetailCache = new Map<string, MarketplaceCacheEntry<MarketplaceGenomeRecord | null>>();
let marketplaceCooldownUntil = 0;

function activateMarketplaceCooldown(): void {
    marketplaceCooldownUntil = Math.max(marketplaceCooldownUntil, Date.now() + MARKETPLACE_RATE_LIMIT_COOLDOWN_MS);
}

function isMarketplaceReadCoolingDown(): boolean {
    return marketplaceCooldownUntil > Date.now();
}

async function readThroughMarketplaceCache<T>(
    cache: Map<string, MarketplaceCacheEntry<T>>,
    key: string,
    fallbackValue: T,
    loader: () => Promise<T>,
    options?: {
        successTtlMs?: number;
        missTtlMs?: number;
        isMiss?: (value: T) => boolean;
    }
): Promise<T> {
    const cached = cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        return cached.promise;
    }

    if (isMarketplaceReadCoolingDown()) {
        if (cached?.resolved !== undefined) {
            return cached.resolved;
        }
        return fallbackValue;
    }

    const staleValue = cached?.resolved;
    const request = (async () => {
        try {
            return await loader();
        } catch (error) {
            if (error instanceof MarketplaceRateLimitedError) {
                activateMarketplaceCooldown();
                return staleValue !== undefined ? staleValue : fallbackValue;
            }
            if (staleValue !== undefined) {
                return staleValue;
            }
            throw error;
        }
    })();

    const entry: MarketplaceCacheEntry<T> = {
        expiresAt: now + (options?.successTtlMs ?? MARKETPLACE_SUCCESS_TTL_MS),
        promise: request,
        resolved: staleValue,
    };
    cache.set(key, entry);

    try {
        const value = await request;
        entry.resolved = value;
        entry.promise = Promise.resolve(value);
        entry.expiresAt = Date.now() + (
            options?.isMiss?.(value)
                ? (options?.missTtlMs ?? MARKETPLACE_MISS_TTL_MS)
                : (options?.successTtlMs ?? MARKETPLACE_SUCCESS_TTL_MS)
        );
        return value;
    } catch (error) {
        if (cache.get(key) === entry) {
            cache.delete(key);
        }
        throw error;
    }
}

function tokenizeMarketplaceQuery(query: string): string[] {
    return uniqueStrings(
        Array.from(query.toLowerCase().match(/[\p{Letter}\p{Number}_-]{2,}/gu) ?? []),
    );
}

async function fetchMarketplaceGenomePage(input: {
    query?: string;
    category?: string;
    runtimeType?: MarketplaceGenomeRecord['runtimeType'];
    limit?: number;
    hubUrl: string;
}): Promise<MarketplaceGenomeRecord[]> {
    const cacheKey = stableStringify({
        query: input.query ?? null,
        category: input.category ?? null,
        runtimeType: input.runtimeType ?? null,
        limit: input.limit ?? 20,
        hubUrl: input.hubUrl,
    });

    return readThroughMarketplaceCache(
        marketplacePageCache,
        cacheKey,
        [],
        async () => {
            const query = new URLSearchParams();

            if (input.query) query.set('q', input.query);
            if (input.category) query.set('category', input.category);
            if (input.runtimeType) query.set('runtimeType', input.runtimeType);
            query.set('sortBy', 'score');
            query.set('limit', String(input.limit ?? 20));

            let response: Response;
            try {
                response = await fetch(`${input.hubUrl}/genomes?${query.toString()}`, {
                    signal: AbortSignal.timeout(5_000),
                });
            } catch (error) {
                throw new Error(`${String(error)}. ${buildMarketplaceConnectionHint(input.hubUrl)}`);
            }

            if (response.status === 429) {
                throw new MarketplaceRateLimitedError();
            }
            if (!response.ok) {
                throw new Error(`genome-hub returned ${response.status}`);
            }

            const payload = await response.json() as { genomes?: MarketplaceGenomeRecord[] };
            return payload.genomes ?? [];
        },
        {
            isMiss: (value) => value.length === 0,
        }
    );
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
    const builderVariants = normalizedRole === 'agent-builder'
        ? runtime === 'codex'
            ? ['agent-builder-codex-r2', 'agent-builder-codex', 'agent-builder']
            : ['agent-builder-r2', 'agent-builder', 'agent-builder-portable']
        : [];

    return uniqueStrings([
        ...builderVariants,
        normalizedRole,
        ...aliases,
    ]);
}

export function resolveSpawnRuntimeForRole(
    role: string,
    requestedRuntime?: 'claude' | 'codex',
): 'claude' | 'codex' {
    if (requestedRuntime) {
        return requestedRuntime;
    }

    return role.trim() === 'agent-builder' ? 'codex' : 'claude';
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

function matchesRequestedRuntime(
    genome: MarketplaceGenomeRecord,
    runtimeType?: 'claude' | 'codex' | 'open-code',
): boolean {
    if (!runtimeType) {
        return true;
    }
    return genome.runtimeType == null || genome.runtimeType === runtimeType;
}

function keepLatestGenomeVersion(genomes: MarketplaceGenomeRecord[]): MarketplaceGenomeRecord[] {
    const latestByLineage = new Map<string, MarketplaceGenomeRecord>();

    for (const genome of genomes) {
        const lineageKey = genome.namespace && genome.name
            ? `${genome.namespace}/${genome.name}`
            : genome.id;
        const existing = latestByLineage.get(lineageKey);

        if (!existing) {
            latestByLineage.set(lineageKey, genome);
            continue;
        }

        const existingVersion = typeof existing.version === 'number' ? existing.version : Number.NEGATIVE_INFINITY;
        const nextVersion = typeof genome.version === 'number' ? genome.version : Number.NEGATIVE_INFINITY;

        if (nextVersion > existingVersion) {
            latestByLineage.set(lineageKey, genome);
        }
    }

    return Array.from(latestByLineage.values());
}

export function selectBestRatedGenomeCandidate(
    genomes: MarketplaceGenomeRecord[],
    roleNames: string[],
    options?: {
        runtimeType?: 'claude' | 'codex' | 'open-code';
        minScore?: number;
        minEvaluationCount?: number;
    }
): MarketplaceGenomeRecord | null {
    const minScore = options?.minScore ?? 60;
    const minEvaluationCount = options?.minEvaluationCount ?? 3;

    const candidates = keepLatestGenomeVersion(genomes)
        .filter((genome) => matchesRequestedRuntime(genome, options?.runtimeType))
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
    runtimeType?: 'claude' | 'codex' | 'open-code';
    limit?: number;
    hubUrl?: string;
}): Promise<MarketplaceGenomeRecord[]> {
    const hubUrl = (options?.hubUrl ?? process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const exactMatches = await fetchMarketplaceGenomePage({
        query: options?.query,
        category: options?.category,
        runtimeType: options?.runtimeType,
        limit: options?.limit,
        hubUrl,
    });

    const tokens = options?.query ? tokenizeMarketplaceQuery(options.query) : [];
    if (exactMatches.length > 0 || tokens.length < 2 || isMarketplaceReadCoolingDown()) {
        return exactMatches;
    }

    const fallbackPages = await Promise.all(tokens.map((token) => fetchMarketplaceGenomePage({
        query: token,
        category: options?.category,
        runtimeType: options?.runtimeType,
        limit: options?.limit,
        hubUrl,
    })));

    const merged = new Map<string, MarketplaceGenomeRecord>();
    for (const genome of exactMatches) {
        merged.set(genome.id, genome);
    }
    for (const page of fallbackPages) {
        for (const genome of page) {
            if (!merged.has(genome.id)) {
                merged.set(genome.id, genome);
            }
        }
    }

    return Array.from(merged.values()).slice(0, options?.limit ?? 20);
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
        const genome = await readThroughMarketplaceCache(
            marketplaceDetailCache,
            url,
            null,
            async () => {
                const response = await fetch(url, {
                    signal: AbortSignal.timeout(5_000),
                });

                if (response.status === 429) {
                    throw new MarketplaceRateLimitedError();
                }
                if (!response.ok) {
                    return null;
                }

                const payload = await response.json() as { genome?: MarketplaceGenomeRecord };
                return payload.genome ?? null;
            },
            {
                isMiss: (value) => value === null,
            }
        );

        if (genome) {
            return genome;
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

export function parseCorpsSpecFromGenome(genome: Pick<MarketplaceGenomeRecord, 'name' | 'category' | 'spec'>): LegionImage {
    if (!genome.spec) {
        throw new Error(`Marketplace record "${genome.name}" has no spec payload.`);
    }

    const parsed = JSON.parse(genome.spec) as LegionImage;
    if (!parsed || !Array.isArray(parsed.members)) {
        throw new Error(`Marketplace record "${genome.name}" is not a valid LegionImage team template.`);
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
            const url = `${baseUrl}/genomes/%40official/${encodeURIComponent(officialName)}`;
            const genome = await readThroughMarketplaceCache(
                marketplaceDetailCache,
                url,
                null,
                async () => {
                    const response = await fetch(url, {
                        signal: AbortSignal.timeout(3_000),
                    });

                    if (response.status === 429) {
                        throw new MarketplaceRateLimitedError();
                    }
                    if (!response.ok) {
                        return null;
                    }

                    const payload = await response.json() as { genome?: MarketplaceGenomeRecord };
                    return payload.genome ?? null;
                },
                {
                    isMiss: (value) => value === null,
                }
            );

            if (genome?.id && (genome.runtimeType == null || genome.runtimeType === runtime)) {
                return { specId: genome.id, matchedName: officialName };
            }
        } catch {
            // Ignore and continue to the next fallback name.
        }
    }

    return { specId: null };
}

export async function resolvePreferredAgentImageId(options: {
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

    // For @official genomes, resolve official lineage first regardless of strategy.
    // GET /genomes/%40official/:name returns latest version even if isPublic=false,
    // whereas marketplace search only returns isPublic=true — evolved versions
    // written as private would be invisible to marketplace but found here.
    const official = await resolveOfficialGenomeSpecId(options.role, options.runtime, options.hubUrl);
    if (official.specId) {
        if (strategy === 'official') {
            return { specId: official.specId, source: 'official', matchedName: official.matchedName };
        }
        // best-rated strategy: prefer official lineage but allow marketplace
        // to override if a higher-rated public alternative exists
        const marketCandidates: MarketplaceGenomeRecord[] = [];
        for (const queryName of preferredNames) {
            try {
                const genomes = await searchMarketplaceGenomes({
                    query: queryName,
                    runtimeType: options.runtime,
                    limit: 8,
                    hubUrl: options.hubUrl,
                });
                marketCandidates.push(...genomes);
            } catch (error) {
                logger.debug(`[genome-marketplace] best-rated lookup failed for ${queryName}: ${String(error)}`);
            }
        }

        const marketBest = selectBestRatedGenomeCandidate(marketCandidates, preferredNames, {
            runtimeType: options.runtime,
        });
        if (marketBest?.id && marketBest.id !== official.specId) {
            // Marketplace found a different genome with better rating — use it
            return { specId: marketBest.id, source: 'best-rated', matchedName: marketBest.name };
        }

        return { specId: official.specId, source: 'official', matchedName: official.matchedName };
    }

    // No official genome found — fall back to marketplace discovery
    if (strategy !== 'official') {
        const marketCandidates: MarketplaceGenomeRecord[] = [];

        for (const queryName of preferredNames) {
            try {
                const genomes = await searchMarketplaceGenomes({
                    query: queryName,
                    runtimeType: options.runtime,
                    limit: 8,
                    hubUrl: options.hubUrl,
                });
                marketCandidates.push(...genomes);
            } catch (error) {
                logger.debug(`[genome-marketplace] best-rated lookup failed for ${queryName}: ${String(error)}`);
            }
        }

        const selected = selectBestRatedGenomeCandidate(marketCandidates, preferredNames, {
            runtimeType: options.runtime,
        });
        if (selected?.id) {
            return { specId: selected.id, source: 'best-rated', matchedName: selected.name };
        }
    }

    return { specId: null, source: 'none' };
}

export const resolvePreferredGenomeSpecId = resolvePreferredAgentImageId;

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
}): LegionImage {
    const aggregated = new Map<string, LegionImage['members'][number]>();

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
        // Strip internal operational fields (initialObjective, sharedContext, commandChain, taskPolicy)
        // from the published spec when isPublic=true — these are team-private config, not marketplace info.
        const publiclyVisible = options.isPublic ?? false;
        const corps = buildPublishedCorpsSpec({
            namespace: options.namespace ?? '@public',
            name: templateName,
            description: `Auto-published corps template for ${teamName}`,
            teamDescription: board?.team?.bootContext?.teamDescription?.trim() || `${teamName} team template`,
            ...(!publiclyVisible ? {
                initialObjective: deriveInitialObjective(board),
                sharedContext: Array.isArray(board?.team?.bootContext?.sharedContext) ? board.team.bootContext.sharedContext : undefined,
                commandChain: Array.isArray(board?.team?.bootContext?.commandChain) ? board.team.bootContext.commandChain : undefined,
                taskPolicy: board?.team?.bootContext?.taskPolicy && typeof board.team.bootContext.taskPolicy === 'object'
                    ? board.team.bootContext.taskPolicy
                    : undefined,
            } : {}),
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
                isPublic: options.isPublic ?? false,
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
