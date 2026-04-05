import type { AgentImage } from '@/api/types/genome';
import { deterministicStringify } from '@/utils/deterministicJson';

function normalizeStringArray(values?: string[]): string[] {
    if (!values?.length) return [];
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function formatBulletSection(title: string, items?: string[]): string {
    const normalized = normalizeStringArray(items);
    if (normalized.length === 0) return '';
    return `## ${title}\n${normalized.map((item) => `- ${item}`).join('\n')}`;
}

function formatIterationGuide(spec: AgentImage): string {
    const guide = spec.memory?.iterationGuide;
    if (!guide) return '';

    const sections: string[] = [];
    const recentChanges = normalizeStringArray(guide.recentChanges);
    const discoveries = normalizeStringArray(guide.discoveries);
    const improvements = normalizeStringArray(guide.improvements);

    if (recentChanges.length > 0) {
        sections.push(`### Recent Changes\n${recentChanges.map((item) => `- ${item}`).join('\n')}`);
    }
    if (discoveries.length > 0) {
        sections.push(`### Discoveries\n${discoveries.map((item) => `- ${item}`).join('\n')}`);
    }
    if (improvements.length > 0) {
        sections.push(`### Improvements\n${improvements.map((item) => `- ${item}`).join('\n')}`);
    }

    if (sections.length === 0) return '';
    return `## Agent Image Iteration Guide\n${sections.join('\n\n')}`;
}

function formatResume(spec: AgentImage): string {
    const performanceRating = spec.resume?.performanceRating;
    const reviews = normalizeStringArray(spec.resume?.reviews);
    if (performanceRating == null && reviews.length === 0) return '';

    const lines: string[] = ['## Agent Image Resume'];
    if (performanceRating != null) {
        lines.push(`- Performance Rating: ${performanceRating}`);
    }
    if (reviews.length > 0) {
        lines.push('- Reviews:');
        lines.push(...reviews.map((review) => `  - ${review}`));
    }
    return lines.join('\n');
}

function formatRuntimeConfig(spec: AgentImage): string {
    const runtimeConfig = spec.operations?.runtimeConfig?.trim();
    if (!runtimeConfig) return '';
    return `## Runtime Operating Notes\n${runtimeConfig}`;
}

function formatRuntimeIdentity(spec: AgentImage): string {
    if (!spec.runtimeType && !spec.lifecycle) return '';

    const payload = {
        runtimeType: spec.runtimeType,
        lifecycle: spec.lifecycle,
    };

    return `## Runtime Identity\n${deterministicStringify(payload)}`;
}

function formatActivationRules(spec: AgentImage): string {
    if (!spec.trigger?.mode && !spec.trigger?.conditions?.length) return '';

    const payload = {
        mode: spec.trigger?.mode,
        conditions: normalizeStringArray(spec.trigger?.conditions),
    };

    return `## Activation Rules\n${deterministicStringify(payload)}`;
}

function formatScope(spec: AgentImage): string {
    const scope = spec.scopeOfResponsibility;
    if (!scope) return '';

    const normalized = {
        ownedPaths: normalizeStringArray(scope.ownedPaths),
        forbiddenPaths: normalizeStringArray(scope.forbiddenPaths),
        outOfScope: normalizeStringArray(scope.outOfScope),
    };

    if (
        normalized.ownedPaths.length === 0 &&
        normalized.forbiddenPaths.length === 0 &&
        normalized.outOfScope.length === 0
    ) {
        return '';
    }

    return `## Scope Of Responsibility\n${deterministicStringify(normalized)}`;
}

function formatModelPreferences(spec: AgentImage): string {
    const hasPreferredModel = Boolean(spec.preferredModel?.trim());
    const hasModelScores = spec.modelScores && Object.keys(spec.modelScores).length > 0;
    if (!hasPreferredModel && !hasModelScores) return '';

    const payload = {
        preferredModel: spec.preferredModel?.trim() || undefined,
        modelScores: spec.modelScores
            ? Object.fromEntries(
                Object.entries(spec.modelScores)
                    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
                    .sort(([left], [right]) => left.localeCompare(right))
            )
            : undefined,
    };

    return `## Model Preferences\n${deterministicStringify(payload)}`;
}

function formatFeedbackMirror(feedbackData?: string | null): string {
    if (!feedbackData) return '';

    let parsed: {
        avgScore?: number;
        evaluationCount?: number;
        latestAction?: string;
        dimensions?: Record<string, number>;
        suggestions?: string[];
        recentBehaviorPatterns?: string[];
    };

    try {
        parsed = JSON.parse(feedbackData);
    } catch {
        return '';
    }

    if (!parsed.evaluationCount || parsed.evaluationCount < 1) return '';

    const lines: string[] = ['## Agent Verdict Mirror'];
    lines.push(`- Evaluation Count: ${parsed.evaluationCount}`);
    if (parsed.avgScore != null) lines.push(`- Average Score: ${Math.round(parsed.avgScore)}`);
    if (parsed.latestAction) lines.push(`- Latest Action: ${parsed.latestAction}`);

    if (parsed.dimensions) {
        const dims = Object.entries(parsed.dimensions)
            .filter(([, v]) => typeof v === 'number')
            .map(([k, v]) => `${k}=${Math.round(v as number)}`)
            .join(' ');
        if (dims) lines.push(`- Dimension Profile: ${dims}`);
    }

    const observations = [
        ...(parsed.recentBehaviorPatterns ?? []),
        ...(parsed.suggestions ?? []),
    ].slice(0, 3);

    if (observations.length > 0) {
        lines.push('- Recent Observations:');
        for (const obs of observations) {
            lines.push(`  - ${obs}`);
        }
    }

    return lines.join('\n');
}

function formatMessagingBehavior(spec: AgentImage): string {
    const messaging = spec.messaging;
    const behavior = spec.behavior;
    const authorities = (spec as any).authorities as string[] | undefined;

    const hasMessaging = messaging && (messaging.listenFrom !== undefined || messaging.replyMode !== undefined || messaging.receiveUserMessages !== undefined);
    const hasBehavior = behavior && (
        behavior.onIdle !== undefined ||
        behavior.onBlocked !== undefined ||
        behavior.canSpawnAgents !== undefined ||
        behavior.requireExplicitAssignment !== undefined ||
        behavior.onRetire !== undefined ||
        behavior.onContextHigh !== undefined
    );
    const hasAuthorities = Array.isArray(authorities) && authorities.length > 0;

    if (!hasMessaging && !hasBehavior && !hasAuthorities) return '';

    const payload: Record<string, unknown> = {};
    if (hasMessaging) {
        payload.messaging = {
            ...(messaging!.listenFrom !== undefined ? { listenFrom: messaging!.listenFrom } : {}),
            ...(messaging!.replyMode !== undefined ? { replyMode: messaging!.replyMode } : {}),
            ...(messaging!.receiveUserMessages !== undefined ? { receiveUserMessages: messaging!.receiveUserMessages } : {}),
        };
    }
    if (hasBehavior) {
        payload.behavior = {
            ...(behavior!.onIdle !== undefined ? { onIdle: behavior!.onIdle } : {}),
            ...(behavior!.onBlocked !== undefined ? { onBlocked: behavior!.onBlocked } : {}),
            ...(behavior!.canSpawnAgents !== undefined ? { canSpawnAgents: behavior!.canSpawnAgents } : {}),
            ...(behavior!.requireExplicitAssignment !== undefined ? { requireExplicitAssignment: behavior!.requireExplicitAssignment } : {}),
            ...(behavior!.onRetire !== undefined ? { onRetire: behavior!.onRetire } : {}),
            ...(behavior!.onContextHigh !== undefined ? { onContextHigh: behavior!.onContextHigh } : {}),
        };
    }
    if (hasAuthorities) {
        payload.authorities = authorities;
    }

    return `## Agent Role Config\n${deterministicStringify(payload)}`;
}


export function buildAgentImageInjection(spec?: AgentImage | null, feedbackData?: string | null): string {
    if (!spec && !feedbackData) return '';

    const sections = [
        ...(spec ? [
            formatMessagingBehavior(spec),
            formatBulletSection('Agent Image Learnings', spec.memory?.learnings),
            formatIterationGuide(spec),
            formatBulletSection('Agent Image Specialties', spec.resume?.specialties),
            formatResume(spec),
            formatBulletSection('Agent Image Common Patterns', spec.operations?.commonPatterns),
            formatRuntimeConfig(spec),
            formatRuntimeIdentity(spec),
            formatActivationRules(spec),
            formatScope(spec),
            formatModelPreferences(spec),
        ] : []),
        formatFeedbackMirror(feedbackData),
    ].filter(Boolean);

    if (sections.length === 0) return '';

    return [
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '[AGENT IMAGE MEMORY INJECTION]',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        sections.join('\n\n'),
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '[END AGENT IMAGE MEMORY INJECTION]',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
}
