/**
 * Agent Score Storage Module
 *
 * Provides local JSON file storage for agent performance scores.
 * Scores are stored at `.aha/scores/agent_scores.json` relative to cwd.
 *
 * v2 scoring model — two-layer hard metrics:
 *   Layer 1 — HardMetrics: raw event counts (tasksAssigned, toolCallCount, tokensUsed, …)
 *   Layer 2 — BusinessMetrics: business-level rates derived from CC-log cross-validation
 *             (taskCompletionRate, firstPassReviewRate, boardComplianceRate, …)
 *
 * The 5 dimensions are computed from BusinessMetrics when available, otherwise
 * from HardMetrics raw counts. Manual dimension override (v1 legacy) is still
 * accepted for backward compatibility, but `overall` must stay within ±20 of
 * the objective `hardMetricsScore`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { configuration } from '@/configuration';

/**
 * Objective event counts recorded during a session.
 * These raw numbers are the source of truth for the derived dimension scores.
 */
export interface HardMetrics {
    /** Tasks formally assigned to this agent during the session */
    tasksAssigned: number;
    /** Tasks marked done/completed during the session */
    tasksCompleted: number;
    /** Tasks that entered a blocked state */
    tasksBlocked: number;
    /** Total tool/MCP calls made (from CC log) */
    toolCallCount: number;
    /** Tool calls that returned isError=true */
    toolErrorCount: number;
    /** Total messages sent to the team (all types) */
    messagesSent: number;
    /** Messages of type task-update or notification (protocol-correct messages) */
    protocolMessages: number;
    /** Total session duration in minutes */
    sessionDurationMinutes: number;
    /** Total tokens consumed (input + output, from CC log) */
    tokensUsed: number;
}

/**
 * Business-level hard metrics — layer 2 above raw event counts.
 * These map directly to the 5 evaluation dimensions and require
 * supervisor cross-validation of team log vs CC log evidence.
 */
export interface BusinessMetrics {
    /** Task completion rate (0.0–1.0): tasksCompleted / tasksAssigned */
    taskCompletionRate: number;
    /** Fraction of submitted items that passed review without rework (0.0–1.0) */
    firstPassReviewRate: number;
    /** Count of tool calls confirmed in CC log evidence (≥ 0) */
    verifiedToolCallCount: number;
    /** Board protocol compliance rate (0.0–1.0): correct board updates / total board updates */
    boardComplianceRate: number;
    /** Claim-evidence delta (0.0–1.0): 0 = perfect CC-log alignment, 1 = all claims unverified */
    claimEvidenceDelta: number;
    /** Bug/regression rate per completed task (0.0+): 0 = no regressions introduced */
    bugRate: number;
}

export interface SessionScore {
    /** Business-facing score: did the session finish the assigned work? */
    taskCompletion: number;
    /** Business-facing score: was the produced work high quality / low rework? */
    codeQuality: number;
    /** Business-facing score: did the agent collaborate correctly with the team? */
    collaboration: number;
    /** Average of the 3 business-facing axes */
    overall: number;
}

export interface AgentScore {
    sessionId: string;
    teamId: string;
    role: string;
    specId?: string;       // genome ID — primary key for feedback aggregation
    specNamespace?: string; // e.g. '@official'
    specName?: string;      // e.g. 'implementer'
    timestamp: number;
    scorer: string;
    /**
     * Raw event counts (v2 layer 1). Source of truth for derived dimensions
     * when businessMetrics is absent.
     */
    hardMetrics?: HardMetrics;
    /**
     * Business-level hard metrics (v2 layer 2). When present, dimensions are
     * computed from these instead of raw HardMetrics counts.
     * Requires supervisor CC-log cross-validation.
     */
    businessMetrics?: BusinessMetrics;
    /**
     * Score computed purely from hard metrics (0-100).
     * `overall` must satisfy |hardMetricsScore - overall| ≤ 20.
     */
    hardMetricsScore?: number;
    /**
     * Canonical 3-axis session score used by the supervisor scoring pipeline.
     * This is what the supervisor explicitly judges per session:
     * task_completion + code_quality + collaboration.
     */
    sessionScore?: SessionScore;
    /**
     * Guardrail result for |hardMetricsScore - sessionScore.overall|.
     */
    scoreGap?: {
        ok: boolean;
        gap: number;
        maxGap: number;
    };
    dimensions: {
        delivery: number;      // 0-100
        integrity: number;     // 0-100
        efficiency: number;    // 0-100
        collaboration: number; // 0-100
        reliability: number;   // 0-100
    };
    overall: number;
    evidence: Record<string, any>;
    recommendations: string[];
    action: 'keep' | 'keep_with_guardrails' | 'mutate' | 'discard';
}

interface ScoreFile {
    version: string;
    scores: AgentScore[];
}

function getCanonicalScorePath(): string {
    return join(configuration.ahaHomeDir, 'scores', 'agent_scores.json');
}

function getLegacyWorkingDirectoryScorePath(): string {
    return join(process.cwd(), '.aha', 'scores', 'agent_scores.json');
}

function getReadableScorePaths(): string[] {
    const canonical = getCanonicalScorePath();
    const legacy = getLegacyWorkingDirectoryScorePath();
    return canonical === legacy ? [canonical] : [canonical, legacy];
}

function dedupeScores(scores: AgentScore[]): AgentScore[] {
    const seen = new Set<string>();
    const deduped: AgentScore[] = [];

    for (const score of scores) {
        const key = [
            score.sessionId,
            score.teamId,
            score.role,
            score.scorer,
            score.timestamp,
            score.specId ?? '',
            score.specNamespace ?? '',
            score.specName ?? '',
            score.action,
        ].join('::');

        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(score);
    }

    deduped.sort((a, b) => a.timestamp - b.timestamp);
    return deduped;
}

/**
 * Read scores from the local JSON file.
 * Returns an empty ScoreFile if the file does not exist or is malformed.
 */
export function readScores(): ScoreFile {
    const allScores: AgentScore[] = [];
    let version = '1.0';

    for (const scorePath of getReadableScorePaths()) {
        if (!existsSync(scorePath)) {
            continue;
        }

        try {
            const raw = readFileSync(scorePath, 'utf-8');
            const parsed = JSON.parse(raw) as ScoreFile;
            version = parsed.version || version;
            if (Array.isArray(parsed.scores)) {
                allScores.push(...parsed.scores);
            }
        } catch {
            // Ignore malformed legacy score files and keep reading other sources.
        }
    }

    return {
        version,
        scores: dedupeScores(allScores),
    };
}

/**
 * Append a single score to the local JSON file.
 * Creates the directory and file if they do not exist.
 */
export function writeScore(score: AgentScore): void {
    const scorePath = getCanonicalScorePath();
    const dir = dirname(scorePath);

    mkdirSync(dir, { recursive: true });

    const file = readScores();
    file.scores.push(score);

    writeFileSync(scorePath, JSON.stringify(file, null, 2), 'utf-8');
}

/**
 * List all scores, optionally filtered by teamId.
 */
export function listScores(teamId?: string): AgentScore[] {
    const file = readScores();

    if (!teamId) {
        return file.scores;
    }

    return file.scores.filter((s) => s.teamId === teamId);
}

/**
 * Get the most recent score for a given sessionId.
 * Returns null if no score exists for that session.
 */
export function getLatestScore(sessionId: string): AgentScore | null {
    const file = readScores();
    const matching = file.scores.filter((s) => s.sessionId === sessionId);

    if (matching.length === 0) {
        return null;
    }

    return matching.reduce((latest, current) =>
        current.timestamp > latest.timestamp ? current : latest
    );
}
