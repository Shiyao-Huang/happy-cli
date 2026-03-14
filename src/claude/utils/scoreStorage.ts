/**
 * Agent Score Storage Module
 *
 * Provides local JSON file storage for agent performance scores.
 * Scores are stored at `.aha/scores/agent_scores.json` relative to cwd.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

export interface AgentScore {
    sessionId: string;
    teamId: string;
    role: string;
    timestamp: number;
    scorer: string;
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
