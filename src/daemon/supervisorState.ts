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

import { constants } from 'node:fs';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

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

export interface SupervisorPendingActionMeta {
    /** Number of deferred retries already attempted by the daemon */
    retryCount: number;
    /** Timestamp of the most recent retry attempt (ms since epoch) */
    lastAttemptAt: number;
    /** Earliest timestamp when the next retry is allowed (ms since epoch) */
    nextRetryAt: number;
    /** Error from the most recent failed retry */
    lastError: string | null;
}

export const SUPERVISOR_PENDING_ACTION_MAX_RETRIES = 3;

export function getPendingActionRetryDelayMs(retryCount: number, baseMs = 60_000): number {
    return baseMs * (2 ** Math.max(0, retryCount));
}

// ── Core state ─────────────────────────────────────────────────────────────

export interface SupervisorState {
    teamId: string;
    /** Timestamp of last supervisor run (ms since epoch) */
    lastRunAt: number;
    /** Index into team messages.jsonl lines array — read from here next time */
    teamLogCursor: number;
    /** Per-claudeLocalSessionId byte offset into Claude raw log files */
    ccLogCursors: Record<string, number>;
    /** Index into ~/.codex/history.jsonl lines array — read from here next time */
    codexHistoryCursor: number;
    /** Per-codex-session byte offset into ~/.codex/sessions/... transcript files */
    codexSessionCursors: Record<string, number>;
    /** Plain-text summary of last supervisor assessment */
    lastConclusion: string;
    /** Structured findings from the last supervisor cycle (agent-specific observations) */
    lastFindings?: Array<{
        agentSessionId: string;
        role: string;
        finding: string;
        severity: 'low' | 'medium' | 'high';
    }>;
    /** Actionable recommendations from the last supervisor cycle */
    lastRecommendations?: string[];
    /** Session ID of the last supervisor run (for --resume) */
    lastSessionId: string | null;
    /** Whether the team is considered terminated (no new supervisor spawns) */
    terminated: boolean;
    /** Timestamp when the supervisor was marked as terminated (ms since epoch, 0 if not terminated) */
    terminatedAt: number;
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
        requestType?: 'stuck' | 'context_overflow' | 'need_collaborator' | 'error' | 'custom';
        severity?: 'low' | 'medium' | 'high' | 'critical';
        description?: string;
        targetSessionId?: string;
    } | {
        type: 'conditional_escalation';
        /** Condition to check (human-readable) */
        condition: string;
        /** Action to take if condition is still true */
        action: string;
        /** Deadline after which the action triggers (ms since epoch) */
        deadline: number;
    } | null;
    /** Retry bookkeeping for pendingAction execution */
    pendingActionMeta: SupervisorPendingActionMeta | null;
    /** Predictions left by the previous run for Phase 0 verification (v2) */
    predictions?: SupervisorPrediction[];
    /** Cumulative calibration statistics (v2) */
    calibration?: SupervisorCalibration;
}

function getStatePath(teamId: string): string {
    return join(configuration.ahaHomeDir, 'supervisor', `state-${teamId}.json`);
}

class SupervisorStateLockTimeoutError extends Error {
    constructor(teamId: string) {
        super(`Failed to acquire supervisor state lock for ${teamId}`);
        this.name = 'SupervisorStateLockTimeoutError';
    }
}

async function withSupervisorStateLock<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
    const statePath = getStatePath(teamId);
    const lockPath = `${statePath}.lock`;
    const maxAttempts = parseInt(process.env.AHA_SUPERVISOR_STATE_LOCK_MAX_ATTEMPTS || '50', 10);
    const retryMs = parseInt(process.env.AHA_SUPERVISOR_STATE_LOCK_RETRY_MS || '100', 10);
    const staleLockTimeoutMs = 10_000;
    let handle: Awaited<ReturnType<typeof open>> | null = null;

    mkdirSync(dirname(statePath), { recursive: true });

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
            break;
        } catch (error: any) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }

            try {
                const lockStats = await stat(lockPath);
                if (Date.now() - lockStats.mtimeMs > staleLockTimeoutMs) {
                    await unlink(lockPath).catch(() => { });
                }
            } catch {
                // ignore races while inspecting/removing stale locks
            }

            await new Promise((resolve) => setTimeout(resolve, retryMs));
        }
    }

    if (!handle) {
        throw new SupervisorStateLockTimeoutError(teamId);
    }

    try {
        return await fn();
    } finally {
        await handle.close();
        await unlink(lockPath).catch(() => { });
    }
}

async function readSupervisorStateUnlocked(teamId: string): Promise<SupervisorState> {
    const statePath = getStatePath(teamId);
    try {
        const raw = JSON.parse(await readFile(statePath, 'utf-8'));
        return { ...defaultState(teamId), ...raw } as SupervisorState;
    } catch {
        return defaultState(teamId);
    }
}

const V2_DEFAULTS: Pick<SupervisorState, 'lastSupervisorPid' | 'pendingAction' | 'pendingActionMeta' | 'predictions' | 'calibration'> = {
    lastSupervisorPid: 0,
    pendingAction: null,
    pendingActionMeta: null,
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
        terminatedAt: 0,
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
    const tmpPath = `${statePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmpPath, statePath);
}

export function markTeamTerminated(teamId: string): void {
    const state = readSupervisorState(teamId);
    writeSupervisorState({ ...state, terminated: true, terminatedAt: Date.now() });
}

export function updateSupervisorRun(
    teamId: string,
    patch: Partial<Pick<SupervisorState, 'teamLogCursor' | 'ccLogCursors' | 'codexHistoryCursor' | 'codexSessionCursors' | 'lastConclusion' | 'lastFindings' | 'lastRecommendations' | 'lastSessionId' | 'idleRuns' | 'lastSupervisorPid' | 'pendingAction' | 'pendingActionMeta' | 'predictions' | 'calibration'>>
): Promise<SupervisorState> {
    return updateSupervisorState(teamId, (state) => ({
        ...state,
        ...patch,
        lastRunAt: Date.now(),
    }));
}

export async function updateSupervisorState(
    teamId: string,
    updater: (state: SupervisorState) => SupervisorState | Promise<SupervisorState>,
): Promise<SupervisorState> {
    try {
        return await withSupervisorStateLock(teamId, async () => {
            const current = await readSupervisorStateUnlocked(teamId);
            const next = await updater(current);
            writeSupervisorState(next);
            return next;
        });
    } catch (error) {
        if (error instanceof SupervisorStateLockTimeoutError) {
            logger.warn(
                `[SUPERVISOR STATE] Lock timeout for ${teamId}; skipping this state update instead of crashing the daemon`
            );
            return readSupervisorState(teamId);
        }

        throw error;
    }
}

export function listSupervisorStates(): SupervisorState[] {
    const supervisorDir = join(configuration.ahaHomeDir, 'supervisor');
    if (!existsSync(supervisorDir)) {
        return [];
    }

    return readdirSync(supervisorDir)
        .filter((filename) => /^state-.+\.json$/.test(filename))
        .map((filename) => {
            const teamId = filename.slice('state-'.length, -'.json'.length);
            return readSupervisorState(teamId);
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
