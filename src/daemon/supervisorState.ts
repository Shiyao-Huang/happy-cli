/**
 * Supervisor State Module
 *
 * Persists per-team supervisor state so each supervisor cycle only reads
 * new content since the last run (cursor-based incremental reading),
 * and can resume a previous session instead of starting from scratch.
 *
 * v3 additions: raw Codex log bookmarks so supervisor can inspect only the
 * unread tail of ~/.codex history + session transcripts each cycle.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

// ── Self-reflexivity types (v2) ────────────────────────────────────────────

export interface SupervisorPrediction {
    /** Agent session ID this prediction is about */
    agentSessionId: string;
    /** Prediction category */
    type: 'score_direction' | 'will_block' | 'will_complete' | 'needs_intervention';
    /** Human-readable prediction description */
    description: string;
    /** Predicted numeric value (for score_direction) */
    predictedValue?: number;
    /** When the prediction was made (ms since epoch) */
    predictedAt: number;
    /** Confidence 0-100 */
    confidence: number;
}

export interface PredictionOutcome {
    prediction: SupervisorPrediction;
    /** What actually happened */
    actualOutcome: string;
    /** Actual numeric value (for score_direction) */
    actualValue?: number;
    /** Whether the prediction was correct */
    correct: boolean;
    /** Calibration error = |confidence/100 - (correct ? 1 : 0)| */
    calibrationError: number;
}

export interface SupervisorCalibration {
    /** Total predictions made (cumulative) */
    totalPredictions: number;
    /** Total correct predictions */
    correctPredictions: number;
    /** Current calibration score = correctPredictions / totalPredictions * 100 */
    calibrationScore: number;
    /** Rolling accuracy over the last N cycles */
    rollingAccuracy: number;
    /** Accuracy breakdown by prediction type */
    accuracyByType: Record<string, { total: number; correct: number }>;
    /** Score bias trend: positive = supervisor overestimates, negative = underestimates */
    scoreBiasTrend: number;
    /** Last updated (ms since epoch) */
    updatedAt: number;
}

// ── Core state ─────────────────────────────────────────────────────────────

export interface SupervisorState {
    teamId: string;
    /** Timestamp of last supervisor run (ms since epoch) */
    lastRunAt: number;
    /** Index into team messages.jsonl lines array — read from here next time */
    teamLogCursor: number;
    /** Per-sessionId byte offset into CC log files */
    ccLogCursors: Record<string, number>;
    /** Index into ~/.codex/history.jsonl lines array — read from here next time */
    codexHistoryCursor: number;
    /** Per-codex-session byte offset into ~/.codex/sessions/... transcript files */
    codexSessionCursors: Record<string, number>;
    /** Plain-text summary of last supervisor assessment */
    lastConclusion: string;
    /** Session ID of the last supervisor run (for --resume) */
    lastSessionId: string | null;
    /** Whether the team is considered terminated (no new supervisor spawns) */
    terminated: boolean;
    /** How many consecutive runs found no new content */
    idleRuns: number;
    /**
     * PID of the currently running (or last) supervisor process.
     * Persisted across daemon restarts so we can do a liveness check
     * (process.kill(pid, 0)) before spawning a second supervisor.
     * 0 means no supervisor has ever been spawned for this team.
     */
    lastSupervisorPid: number;
    /**
     * Deferred action to execute on the NEXT run if there is still no new
     * content (i.e. the situation has not changed since this was set).
     * Set by supervisor when it concludes "if nothing changes, intervene".
     * Cleared after execution or when new content arrives and supervisor
     * decides the situation has resolved.
     */
    pendingAction: {
        type: 'notify_help';
        message: string;
    } | {
        type: 'conditional_escalation';
        /** Condition to check (human-readable) */
        condition: string;
        /** Action to take if condition is still true */
        action: string;
        /** Deadline after which the action triggers (ms since epoch) */
        deadline: number;
    } | null;
    /** Predictions left by the previous run for Phase 0 verification (v2) */
    predictions?: SupervisorPrediction[];
    /** Cumulative calibration statistics (v2) */
    calibration?: SupervisorCalibration;
}

function getStatePath(teamId: string): string {
    return join(process.cwd(), '.aha', 'supervisor', `state-${teamId}.json`);
}

const V2_DEFAULTS: Pick<SupervisorState, 'lastSupervisorPid' | 'pendingAction' | 'predictions' | 'calibration'> = {
    lastSupervisorPid: 0,
    pendingAction: null,
    predictions: undefined,
    calibration: undefined,
};

function defaultState(teamId: string): SupervisorState {
    return {
        teamId,
        lastRunAt: 0,
        teamLogCursor: 0,
        ccLogCursors: {},
        codexHistoryCursor: 0,
        codexSessionCursors: {},
        lastConclusion: '',
        lastSessionId: null,
        terminated: false,
        idleRuns: 0,
        ...V2_DEFAULTS,
    };
}

export function readSupervisorState(teamId: string): SupervisorState {
    const statePath = getStatePath(teamId);
    if (!existsSync(statePath)) {
        return defaultState(teamId);
    }
    try {
        const raw = JSON.parse(readFileSync(statePath, 'utf-8'));
        // Back-fill fields added after initial rollout (v1 + v2)
        return { ...defaultState(teamId), ...raw } as SupervisorState;
    } catch {
        return defaultState(teamId);
    }
}

export function writeSupervisorState(state: SupervisorState): void {
    const statePath = getStatePath(state.teamId);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function markTeamTerminated(teamId: string): void {
    const state = readSupervisorState(teamId);
    writeSupervisorState({ ...state, terminated: true });
}

export function updateSupervisorRun(
    teamId: string,
    patch: Partial<Pick<SupervisorState, 'teamLogCursor' | 'ccLogCursors' | 'codexHistoryCursor' | 'codexSessionCursors' | 'lastConclusion' | 'lastSessionId' | 'idleRuns' | 'lastSupervisorPid' | 'pendingAction' | 'predictions' | 'calibration'>>
): void {
    const state = readSupervisorState(teamId);
    writeSupervisorState({
        ...state,
        ...patch,
        lastRunAt: Date.now(),
    });
}

// ── Calibration helpers (v2) ────────────────────────────────────────────────

const ROLLING_WINDOW = 5;

/**
 * Update calibration statistics with new prediction outcomes.
 * Returns the updated calibration object.
 */
export function updateCalibration(
    existing: SupervisorCalibration | undefined,
    outcomes: PredictionOutcome[],
): SupervisorCalibration {
    const base: SupervisorCalibration = existing ?? {
        totalPredictions: 0,
        correctPredictions: 0,
        calibrationScore: 0,
        rollingAccuracy: 0,
        accuracyByType: {},
        scoreBiasTrend: 0,
        updatedAt: 0,
    };

    let { totalPredictions, correctPredictions, accuracyByType } = base;

    // Accumulate score bias deltas for trend calculation
    const biasDeltas: number[] = [];

    for (const o of outcomes) {
        totalPredictions++;
        if (o.correct) correctPredictions++;

        // Update per-type accuracy
        const typeKey = o.prediction.type;
        const entry = accuracyByType[typeKey] ?? { total: 0, correct: 0 };
        entry.total++;
        if (o.correct) entry.correct++;
        accuracyByType[typeKey] = entry;

        // Track score bias (predicted - actual) for score_direction predictions
        if (o.prediction.predictedValue != null && o.actualValue != null) {
            biasDeltas.push(o.prediction.predictedValue - o.actualValue);
        }
    }

    const calibrationScore = totalPredictions > 0
        ? Math.round((correctPredictions / totalPredictions) * 100)
        : 0;

    // Rolling accuracy: use this batch as one data point
    const batchAccuracy = outcomes.length > 0
        ? outcomes.filter(o => o.correct).length / outcomes.length
        : 0;
    // Exponential moving average with weight = 1/ROLLING_WINDOW
    const alpha = 1 / ROLLING_WINDOW;
    const rollingAccuracy = base.rollingAccuracy > 0
        ? Math.round((alpha * batchAccuracy * 100 + (1 - alpha) * base.rollingAccuracy))
        : Math.round(batchAccuracy * 100);

    // Score bias trend: running average of (predicted - actual)
    const newBias = biasDeltas.length > 0
        ? biasDeltas.reduce((s, d) => s + d, 0) / biasDeltas.length
        : 0;
    const scoreBiasTrend = base.scoreBiasTrend !== 0
        ? Math.round((alpha * newBias + (1 - alpha) * base.scoreBiasTrend) * 10) / 10
        : Math.round(newBias * 10) / 10;

    return {
        totalPredictions,
        correctPredictions,
        calibrationScore,
        rollingAccuracy,
        accuracyByType,
        scoreBiasTrend,
        updatedAt: Date.now(),
    };
}
