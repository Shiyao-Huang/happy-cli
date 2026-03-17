/**
 * Feedback Privacy Filter
 *
 * Computes what gets sent to the PUBLIC genome marketplace from local score data.
 *
 * ── Data architecture ──────────────────────────────────────────────────────
 *
 *   Local .aha/scores/agent_scores.json   ← NEVER modified here
 *     Full fidelity record kept for internal audit and traceability:
 *     sessionId, teamId, scorer, evidence (raw tool calls), recommendations
 *
 *   Public genome-hub marketplace (PATCH /genomes/.../feedback)
 *     Aggregate statistics only — no individual session data:
 *     avgScore, sessionScore, dimensions, distribution, anonymized behavioral suggestions
 *
 * ── What gets anonymized in suggestions before upload ──────────────────────
 *   File paths   → [path]      (project structure is private)
 *   Secret keys  → [REDACTED]  (never leak credentials)
 *   UUIDs        → [id]        (session/team IDs must not appear in public)
 *   IPs          → [ip]
 *   URLs         → [url]
 *
 * ── What is kept ───────────────────────────────────────────────────────────
 *   Behavioral patterns ("agent exceeds scope", "never marks task in_progress")
 *   Score dimensions and averages
 *   Action recommendations (keep / mutate / discard)
 */

import type { AgentScore, HardMetrics, BusinessMetrics } from './scoreStorage';
import { computeSessionScoreFromDimensions } from './sessionScoring';

/**
 * Convert raw event counts (HardMetrics layer 1) into dimension scores.
 * Used as fallback when BusinessMetrics are not available.
 *
 * Mapping:
 *   delivery      = task completion rate (tasksCompleted / tasksAssigned)
 *   integrity     = low blocked-task rate (1 - tasksBlocked / tasksAssigned)
 *   efficiency    = token efficiency (50k tokens/task → 100; 200k → ~25)
 *   collaboration = protocol adherence (protocolMessages / messagesSent)
 *   reliability   = tool success rate (1 - toolErrors / toolCalls)
 *
 * Defaults are neutral (50-80) when the denominator is zero (no data available).
 */
export function computeDimensionsFromHardMetrics(m: HardMetrics): {
    delivery: number;
    integrity: number;
    efficiency: number;
    collaboration: number;
    reliability: number;
} {
    // delivery: task completion rate
    const delivery = m.tasksAssigned > 0
        ? Math.min(100, Math.round((m.tasksCompleted / m.tasksAssigned) * 100))
        : 50;

    // integrity: low blocker rate
    const integrity = m.tasksAssigned > 0
        ? Math.min(100, Math.round((1 - Math.min(1, m.tasksBlocked / m.tasksAssigned)) * 100))
        : 75;

    // efficiency: tokens consumed per completed task, normalized
    // Baseline: 50 000 tokens/task → score 100; 200 000 tokens/task → ~25
    const tokensPerTask = m.tasksCompleted > 0 && m.tokensUsed > 0
        ? m.tokensUsed / m.tasksCompleted
        : null;
    const efficiency = tokensPerTask !== null
        ? Math.min(100, Math.max(10, Math.round(5_000_000 / tokensPerTask)))
        : 60;

    // collaboration: ratio of protocol-correct messages (task-updates + notifications)
    // 50 % protocol messages → 100 score (so we multiply by 2, cap at 100)
    const collaboration = m.messagesSent > 0
        ? Math.min(100, Math.round((m.protocolMessages / m.messagesSent) * 200))
        : 50;

    // reliability: tool success rate
    const reliability = m.toolCallCount > 0
        ? Math.min(100, Math.round(((m.toolCallCount - m.toolErrorCount) / m.toolCallCount) * 100))
        : 80;

    return { delivery, integrity, efficiency, collaboration, reliability };
}

/**
 * Compute dimension scores from BusinessMetrics (layer 2), falling back to
 * HardMetrics (layer 1) when businessMetrics is not provided.
 *
 * BusinessMetrics dimension mapping:
 *   delivery      = taskCompletionRate × 100
 *   integrity     = (1 − claimEvidenceDelta) × 100  (claim truthfulness)
 *   efficiency    = token efficiency from raw HardMetrics (still needs raw counts)
 *   collaboration = boardComplianceRate × 100
 *   reliability   = (1 − min(1, bugRate)) × 100  (regressions per task)
 *
 * firstPassReviewRate and verifiedToolCallCount inform the `evidence` context
 * but are also folded into reliability/integrity respectively:
 *   - firstPassReviewRate weights into reliability (first-pass quality proxy)
 *   - verifiedToolCallCount/toolCallCount ratio adjusts integrity
 */
export function computeDimensionsFromMetrics(
    raw: HardMetrics,
    business?: BusinessMetrics,
): {
    delivery: number;
    integrity: number;
    efficiency: number;
    collaboration: number;
    reliability: number;
} {
    if (!business) {
        return computeDimensionsFromHardMetrics(raw);
    }

    // delivery: directly from taskCompletionRate
    const delivery = Math.min(100, Math.max(0, Math.round(business.taskCompletionRate * 100)));

    // integrity: claim-evidence alignment + verified tool call ratio
    // claimEvidenceDelta=0 → perfect; weighted 70% claim truth + 30% firstPassReview
    const claimTruth = Math.min(100, Math.max(0, Math.round((1 - business.claimEvidenceDelta) * 100)));
    const firstPassBonus = Math.min(100, Math.max(0, Math.round(business.firstPassReviewRate * 100)));
    const integrity = Math.round(claimTruth * 0.7 + firstPassBonus * 0.3);

    // efficiency: still token-based from raw counts (business layer doesn't track tokens)
    const tokensPerTask = raw.tasksCompleted > 0 && raw.tokensUsed > 0
        ? raw.tokensUsed / raw.tasksCompleted
        : null;
    const efficiency = tokensPerTask !== null
        ? Math.min(100, Math.max(10, Math.round(5_000_000 / tokensPerTask)))
        : 60;

    // collaboration: board protocol compliance
    const collaboration = Math.min(100, Math.max(0, Math.round(business.boardComplianceRate * 100)));

    // reliability: first-pass quality (no regressions) weighted 60%, tool success 40%
    const noBugScore = Math.min(100, Math.max(0, Math.round((1 - Math.min(1, business.bugRate)) * 100)));
    const toolSuccessScore = raw.toolCallCount > 0
        ? Math.min(100, Math.round(((raw.toolCallCount - raw.toolErrorCount) / raw.toolCallCount) * 100))
        : 80;
    const reliability = Math.round(noBugScore * 0.6 + toolSuccessScore * 0.4);

    return { delivery, integrity, efficiency, collaboration, reliability };
}

/**
 * Compute the hard-metrics-only score (0-100).
 * This value is stored as `hardMetricsScore` and must stay within ±20 of `overall`.
 */
export function computeHardMetricsScore(
    raw: HardMetrics,
    business?: BusinessMetrics,
): number {
    const dims = computeDimensionsFromMetrics(raw, business);
    return Math.round(
        (dims.delivery + dims.integrity + dims.efficiency + dims.collaboration + dims.reliability) / 5,
    );
}

/**
 * Validate that the overall score is within 20 points of the hard metrics score.
 * Returns a warning string if the gap is too large, or null if within bounds.
 */
export function validateScoreGap(hardMetricsScore: number, overall: number, maxGap: number = 20): string | null {
    const gap = Math.abs(hardMetricsScore - overall);
    if (gap > maxGap) {
        return `Score gap too large: hardMetricsScore=${hardMetricsScore}, overall=${overall}, gap=${gap} (max ${maxGap}). Override must stay within ±${maxGap} of objective score.`;
    }
    return null;
}

// ── Pattern library for PII detection ────────────────────────────────────────

/** UUID v4 pattern */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** File path patterns (Unix, Windows, relative) */
const PATH_RE = /(?:\/[\w.-]+){2,}|[A-Za-z]:\\[\w\\.-]+|\.\.?\/[\w./-]+/g;

/** IP address pattern */
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

/** URL pattern */
const URL_RE = /https?:\/\/[^\s"']+/gi;

/** Common secret key patterns */
const SECRET_RE = /\b(?:sk-|ghp_|gho_|AKIA)[A-Za-z0-9_-]{10,}/g;

/**
 * Sanitize a single suggestion string by removing PII patterns.
 * Returns null if the suggestion becomes too short after sanitization.
 */
export function sanitizeSuggestion(text: string): string | null {
    let s = text
        .replace(SECRET_RE, '[REDACTED]')
        .replace(UUID_RE, '[id]')
        .replace(URL_RE, '[url]')
        .replace(IP_RE, '[ip]')
        .replace(PATH_RE, '[path]');

    // Trim and check length
    s = s.trim();
    if (s.length < 15) return null;  // Too short after sanitization — skip

    // Cap length
    return s.slice(0, 200);
}

/**
 * Aggregate scores and extract sanitized suggestions for marketplace upload.
 * Returns null if there are no scores to aggregate.
 */
export interface AggregatedFeedback {
    evaluationCount: number;
    avgScore: number;
    sessionScore: {
        taskCompletion: number;
        codeQuality: number;
        collaboration: number;
        overall: number;
    };
    dimensions: {
        delivery: number;
        integrity: number;
        efficiency: number;
        collaboration: number;
        reliability: number;
    };
    distribution: {
        excellent: number;   // 90-100
        good: number;        // 70-89
        fair: number;        // 50-69
        poor: number;        // 0-49
    };
    latestAction: 'keep' | 'keep_with_guardrails' | 'mutate' | 'discard';
    suggestions: string[];
}

export function aggregateScores(scores: AgentScore[]): AggregatedFeedback | null {
    if (scores.length === 0) return null;

    // Compute averages
    const count = scores.length;
    const sumDims = scores.reduce(
        (acc, s) => ({
            delivery: acc.delivery + s.dimensions.delivery,
            integrity: acc.integrity + s.dimensions.integrity,
            efficiency: acc.efficiency + s.dimensions.efficiency,
            collaboration: acc.collaboration + s.dimensions.collaboration,
            reliability: acc.reliability + s.dimensions.reliability,
        }),
        { delivery: 0, integrity: 0, efficiency: 0, collaboration: 0, reliability: 0 }
    );
    const sumSession = scores.reduce(
        (acc, s) => {
            const session = s.sessionScore ?? computeSessionScoreFromDimensions(s.dimensions);
            return {
                taskCompletion: acc.taskCompletion + session.taskCompletion,
                codeQuality: acc.codeQuality + session.codeQuality,
                collaboration: acc.collaboration + session.collaboration,
                overall: acc.overall + session.overall,
            };
        },
        { taskCompletion: 0, codeQuality: 0, collaboration: 0, overall: 0 }
    );

    const avgDims = {
        delivery: Math.round(sumDims.delivery / count),
        integrity: Math.round(sumDims.integrity / count),
        efficiency: Math.round(sumDims.efficiency / count),
        collaboration: Math.round(sumDims.collaboration / count),
        reliability: Math.round(sumDims.reliability / count),
    };
    const avgSessionScore = {
        taskCompletion: Math.round(sumSession.taskCompletion / count),
        codeQuality: Math.round(sumSession.codeQuality / count),
        collaboration: Math.round(sumSession.collaboration / count),
        overall: Math.round(sumSession.overall / count),
    };

    const avgScore = Math.round(scores.reduce((sum, s) => sum + s.overall, 0) / count);

    // Score distribution
    const distribution = { excellent: 0, good: 0, fair: 0, poor: 0 };
    for (const s of scores) {
        if (s.overall >= 90) distribution.excellent++;
        else if (s.overall >= 70) distribution.good++;
        else if (s.overall >= 50) distribution.fair++;
        else distribution.poor++;
    }

    // Latest action
    const sorted = [...scores].sort((a, b) => b.timestamp - a.timestamp);
    const latestAction = sorted[0].action;

    // Sanitize and deduplicate suggestions
    const rawSuggestions = scores.flatMap(s => s.recommendations ?? []);
    const sanitized = rawSuggestions
        .map(sanitizeSuggestion)
        .filter((s): s is string => s !== null);

    // Deduplicate by prefix similarity (keep unique behavioral patterns)
    const unique = Array.from(new Set(sanitized)).slice(0, 10);

    return {
        evaluationCount: count,
        avgScore,
        sessionScore: avgSessionScore,
        dimensions: avgDims,
        distribution,
        latestAction,
        suggestions: unique,
    };
}
