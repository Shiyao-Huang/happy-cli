import type { SessionGenomeMapping } from '@/claude/utils/sessionGenomeMap';
import {
    createEntityTrialById,
    createEntityVerdict,
    listEntityTrialsById,
    materializeEntityFeedback,
    type EntityTrialRecord,
} from './entityHub';

type EntityLogRef = EntityTrialRecord['logRefs'][number];

type ScoreDimensions = {
    delivery: number;
    integrity: number;
    efficiency: number;
    collaboration: number;
    reliability: number;
};

type RecordScoreAgentVerdictArgs = {
    token?: string;
    entityId: string;
    sessionId: string;
    teamId: string;
    scoredRole: string;
    readerRole: string;
    readerSessionId?: string;
    overall: number;
    action: 'keep' | 'keep_with_guardrails' | 'mutate' | 'discard';
    dimensions: ScoreDimensions;
    recommendations?: string[];
    mapping?: SessionGenomeMapping | null;
};

function trialHasSession(trial: EntityTrialRecord, sessionId: string): boolean {
    return trial.logRefs.some((ref) => ref.sessionId === sessionId || ref.path.includes(sessionId));
}

export function buildScoreAgentEntityLogRefs(args: {
    sessionId: string;
    teamId: string;
    mapping?: SessionGenomeMapping | null;
}): EntityLogRef[] {
    const refs: EntityLogRef[] = [
        { kind: 'other', path: `aha://session/${args.sessionId}`, sessionId: args.sessionId },
        { kind: 'team', path: `aha://team/${args.teamId}` },
    ];

    if (args.mapping?.claudeSessionId) {
        refs.push({
            kind: 'claude',
            path: `claude://session/${args.mapping.claudeSessionId}`,
            sessionId: args.mapping.claudeSessionId,
        });
    }
    if (args.mapping?.codexRolloutId) {
        refs.push({
            kind: 'codex',
            path: `codex://rollout/${args.mapping.codexRolloutId}`,
            sessionId: args.mapping.codexRolloutId,
        });
    }

    return refs;
}

export function buildScoreAgentVerdictContent(args: {
    scoredRole: string;
    sessionId: string;
    overall: number;
    action: RecordScoreAgentVerdictArgs['action'];
    dimensions: ScoreDimensions;
    recommendations?: string[];
}): string {
    return [
        `Role: ${args.scoredRole}, Session: ${args.sessionId}`,
        `Overall: ${args.overall}/100, Action: ${args.action}`,
        `Dimensions: delivery=${args.dimensions.delivery} integrity=${args.dimensions.integrity} efficiency=${args.dimensions.efficiency} collaboration=${args.dimensions.collaboration} reliability=${args.dimensions.reliability}`,
        args.recommendations?.length ? `Recommendations: ${args.recommendations.join('; ')}` : '',
    ].filter(Boolean).join('\n');
}

export async function recordScoreAgentVerdict(args: RecordScoreAgentVerdictArgs): Promise<{
    trialId: string | null;
    verdictId: string | null;
}> {
    const existingTrials = await listEntityTrialsById({ entityId: args.entityId });
    const logRefs = buildScoreAgentEntityLogRefs({
        sessionId: args.sessionId,
        teamId: args.teamId,
        mapping: args.mapping,
    });

    let trialId = existingTrials.find((trial) => trialHasSession(trial, args.sessionId))?.id ?? null;
    if (!trialId) {
        const created = await createEntityTrialById({
            token: args.token,
            entityId: args.entityId,
            teamId: args.teamId,
            contextNarrative: `score_agent trial for session ${args.sessionId}`,
            logRefs,
        });
        trialId = created.trial.id;
    }

    const verdictContent = buildScoreAgentVerdictContent({
        scoredRole: args.scoredRole,
        sessionId: args.sessionId,
        overall: args.overall,
        action: args.action,
        dimensions: args.dimensions,
        recommendations: args.recommendations,
    });

    const verdict = await createEntityVerdict({
        token: args.token,
        trialId,
        readerRole: args.readerRole,
        readerSessionId: args.readerSessionId,
        content: verdictContent,
        score: args.overall,
        action: args.action,
        dimensions: args.dimensions,
        contextNarrative: `score_agent verdict for session ${args.sessionId}`,
    });

    await materializeEntityFeedback({
        token: args.token,
        entityId: args.entityId,
    });

    return {
        trialId,
        verdictId: verdict.verdict.id ?? null,
    };
}
