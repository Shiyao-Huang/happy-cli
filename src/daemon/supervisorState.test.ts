import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfiguration = vi.hoisted(() => ({
    ahaHomeDir: '',
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

import {
    getPendingActionRetryDelayMs,
    listSupervisorStates,
    readSupervisorState,
    updateSupervisorRun,
    updateSupervisorState,
    writeSupervisorState,
} from './supervisorState';

function getExpectedStatePath(root: string, teamId: string): string {
    return join(root, 'supervisor', `state-${teamId}.json`);
}

describe('supervisorState', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'aha-supervisor-state-'));
        mockConfiguration.ahaHomeDir = root;
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('stores supervisor state under configuration.ahaHomeDir', () => {
        writeSupervisorState({
            ...readSupervisorState('team-1'),
            lastConclusion: 'ok',
        });

        expect(existsSync(getExpectedStatePath(root, 'team-1'))).toBe(true);
    });

    it('writes state atomically via temp file rename and leaves no temp file behind', () => {
        writeSupervisorState({
            ...readSupervisorState('team-1'),
            lastConclusion: 'ok',
        });

        const path = getExpectedStatePath(root, 'team-1');
        expect(existsSync(path)).toBe(true);
        expect(existsSync(`${path}.tmp`)).toBe(false);

        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        expect(raw.lastConclusion).toBe('ok');
    });

    it('updates supervisor runs using the stable persisted location', () => {
        return updateSupervisorRun('team-2', {
            lastSupervisorPid: 1234,
            lastConclusion: 'running',
        }).then(() => {
            const stored = readSupervisorState('team-2');
            expect(stored.lastSupervisorPid).toBe(1234);
            expect(stored.lastConclusion).toBe('running');
            expect(stored.lastRunAt).toBeGreaterThan(0);
        });
    });

    it('serializes concurrent read-modify-write updates instead of dropping fields', async () => {
        await Promise.all([
            updateSupervisorState('team-3', (state) => ({ ...state, lastConclusion: 'alpha' })),
            updateSupervisorState('team-3', (state) => ({ ...state, lastSupervisorPid: 99 })),
        ]);

        const stored = readSupervisorState('team-3');
        expect(stored.lastConclusion).toBe('alpha');
        expect(stored.lastSupervisorPid).toBe(99);
    });

    it('back-fills pendingActionMeta defaults for legacy state files', () => {
        const legacyPath = getExpectedStatePath(root, 'team-legacy');
        mkdirSync(join(root, 'supervisor'), { recursive: true });
        writeFileSync(legacyPath, JSON.stringify({
            teamId: 'team-legacy',
            pendingAction: {
                type: 'notify_help',
                message: '[high] legacy help request',
            },
        }), 'utf-8');

        const stored = readSupervisorState('team-legacy');
        expect(stored.pendingAction?.type).toBe('notify_help');
        expect(stored.pendingActionMeta).toBeNull();
    });

    it('lists every persisted supervisor state under ahaHomeDir', () => {
        writeSupervisorState({
            ...readSupervisorState('team-a'),
            lastConclusion: 'alpha',
        });
        writeSupervisorState({
            ...readSupervisorState('team-b'),
            lastConclusion: 'beta',
        });

        const states = listSupervisorStates();
        expect(states.map((state) => state.teamId).sort()).toEqual(['team-a', 'team-b']);
    });

    it('computes exponential pendingAction retry backoff', () => {
        expect(getPendingActionRetryDelayMs(0, 1_000)).toBe(1_000);
        expect(getPendingActionRetryDelayMs(1, 1_000)).toBe(2_000);
        expect(getPendingActionRetryDelayMs(2, 1_000)).toBe(4_000);
    });
});
