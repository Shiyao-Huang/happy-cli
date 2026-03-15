/**
 * Supervisor State Module
 *
 * Persists per-team supervisor state so each supervisor cycle only reads
 * new content since the last run (cursor-based incremental reading),
 * and can resume a previous session instead of starting from scratch.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

export interface SupervisorState {
    teamId: string;
    /** Timestamp of last supervisor run (ms since epoch) */
    lastRunAt: number;
    /** Index into team messages.jsonl lines array — read from here next time */
    teamLogCursor: number;
    /** Per-sessionId byte offset into CC log files */
    ccLogCursors: Record<string, number>;
    /** Plain-text summary of last supervisor assessment */
    lastConclusion: string;
    /** Session ID of the last supervisor run (for --resume) */
    lastSessionId: string | null;
    /** Whether the team is considered terminated (no new supervisor spawns) */
    terminated: boolean;
    /** How many consecutive runs found no new content */
    idleRuns: number;
}

function getStatePath(teamId: string): string {
    return join(process.cwd(), '.aha', 'supervisor', `state-${teamId}.json`);
}

export function readSupervisorState(teamId: string): SupervisorState {
    const statePath = getStatePath(teamId);
    if (!existsSync(statePath)) {
        return {
            teamId,
            lastRunAt: 0,
            teamLogCursor: 0,
            ccLogCursors: {},
            lastConclusion: '',
            lastSessionId: null,
            terminated: false,
            idleRuns: 0,
        };
    }
    try {
        return JSON.parse(readFileSync(statePath, 'utf-8')) as SupervisorState;
    } catch {
        return {
            teamId,
            lastRunAt: 0,
            teamLogCursor: 0,
            ccLogCursors: {},
            lastConclusion: '',
            lastSessionId: null,
            terminated: false,
            idleRuns: 0,
        };
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
    patch: Partial<Pick<SupervisorState, 'teamLogCursor' | 'ccLogCursors' | 'lastConclusion' | 'lastSessionId' | 'idleRuns'>>
): void {
    const state = readSupervisorState(teamId);
    writeSupervisorState({
        ...state,
        ...patch,
        lastRunAt: Date.now(),
    });
}
