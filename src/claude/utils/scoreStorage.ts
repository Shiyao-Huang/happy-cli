/**
 * Agent Score Storage Module
 *
 * Provides local JSON file storage for agent performance scores.
 * Scores are stored at `.aha/scores/agent_scores.json` relative to cwd.
 *
 * v2 scoring model: hard (objective) metrics replace subjective 5-dimension input.
 * The 5 dimensions (delivery, integrity, efficiency, collaboration, reliability)
 * are now DERIVED from raw event counts rather than manually assigned by the supervisor.
 * Legacy manually-assigned dimensions are still accepted for backward compatibility.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

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
     * Raw event counts (v2). When present, `dimensions` are computed from these.
     * When absent, `dimensions` contain manually-assigned values (v1 legacy).
     */
    hardMetrics?: HardMetrics;
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

function getScorePath(): string {
    return join(process.cwd(), '.aha', 'scores', 'agent_scores.json');
}

/**
 * Read scores from the local JSON file.
 * Returns an empty ScoreFile if the file does not exist or is malformed.
 */
export function readScores(): ScoreFile {
    const scorePath = getScorePath();

    if (!existsSync(scorePath)) {
        return { version: '1.0', scores: [] };
    }

    try {
        const raw = readFileSync(scorePath, 'utf-8');
        const parsed = JSON.parse(raw) as ScoreFile;
        return {
            version: parsed.version || '1.0',
            scores: Array.isArray(parsed.scores) ? parsed.scores : [],
        };
    } catch {
        return { version: '1.0', scores: [] };
    }
}

/**
 * Append a single score to the local JSON file.
 * Creates the directory and file if they do not exist.
 */
export function writeScore(score: AgentScore): void {
    const scorePath = getScorePath();
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
