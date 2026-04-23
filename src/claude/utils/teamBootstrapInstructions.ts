import type { AgentImage } from '@/api/types/genome';
import { logger } from '@/ui/logger';
import { serializeErrorForLog } from '@/utils/serializeErrorForLog';

export type FetchAgentImageFn = (token: string, specId: string) => Promise<AgentImage | null>;

export interface TeamContextGenomeResolution {
    genome: AgentImage | null;
    source:
        | 'already-ready'
        | 'already-missing-prompt'
        | 'no-spec'
        | 'jit-fetch'
        | 'jit-fetch-missing-prompt'
        | 'jit-fetch-null'
        | 'jit-fetch-failed';
    error?: unknown;
}

export async function resolveTeamContextGenomeForInjection(args: {
    token: string;
    specId?: string;
    startupGenome: AgentImage | null | undefined;
    agentImageRef: { current: AgentImage | null | undefined };
    fetchAgentImage: FetchAgentImageFn;
    onGenomeResolved?: (genome: AgentImage) => void;
}): Promise<TeamContextGenomeResolution> {
    const currentGenome = args.agentImageRef.current ?? args.startupGenome ?? null;

    if (currentGenome?.systemPrompt) {
        return { genome: currentGenome, source: 'already-ready' };
    }

    if (!args.specId) {
        return { genome: currentGenome, source: 'no-spec' };
    }

    logger.warn(
        `[runClaude] Genome systemPrompt not ready at team context injection; retrying fetch (specId=${args.specId})`,
    );

    try {
        const refreshedGenome = await args.fetchAgentImage(args.token, args.specId);
        if (!refreshedGenome) {
            logger.warn(`[runClaude] JIT genome fetch returned null (specId=${args.specId})`);
            return { genome: currentGenome, source: 'jit-fetch-null' };
        }

        args.agentImageRef.current = refreshedGenome;
        args.onGenomeResolved?.(refreshedGenome);

        if (!refreshedGenome.systemPrompt) {
            logger.warn(`[runClaude] JIT genome fetch succeeded but systemPrompt is still missing (specId=${args.specId})`);
            return { genome: refreshedGenome, source: 'jit-fetch-missing-prompt' };
        }

        logger.debug(`[genome] JIT fetched genome for team context (specId=${args.specId}, v${refreshedGenome.version ?? '?'})`);
        return { genome: refreshedGenome, source: 'jit-fetch' };
    } catch (error) {
        logger.warn(
            `[runClaude] JIT genome fetch failed at team context injection (specId=${args.specId})`,
            serializeErrorForLog(error),
        );
        return { genome: currentGenome, source: currentGenome ? 'already-missing-prompt' : 'jit-fetch-failed', error };
    }
}

export function hasOrgManagerBootstrapTask(role: string | undefined, taskPrompt: string | undefined): boolean {
    return role === 'org-manager' && Boolean(taskPrompt?.trim());
}

export function buildBootstrapFallbackInstructions(args: {
    role?: string;
    specId?: string;
    resolutionSource?: TeamContextGenomeResolution['source'];
}): string {
    const role = args.role || 'agent';
    const specLine = args.specId
        ? `The intended genome spec is ${args.specId}, but its systemPrompt was unavailable during bootstrap (${args.resolutionSource ?? 'unknown'}).`
        : 'No genome spec was available during bootstrap.';

    return [
        `You are a degraded bootstrap runtime for role: ${role}.`,
        specLine,
        'Do not idle or wait for another instruction. Preserve the user startup task and continue with the safest minimal team protocol.',
        'First inspect the team with get_team_info/list_tasks as needed, then for org-manager use list_available_agents and create_agent to assemble the requested team.',
        'If any required capability or permission is missing, report a visible blocker in team chat instead of silently stopping.',
    ].join('\n');
}
