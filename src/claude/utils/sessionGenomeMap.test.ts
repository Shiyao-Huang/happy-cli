import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalEnv = process.env;

async function loadSessionGenomeMapModule(homeDir: string) {
    process.env = {
        ...originalEnv,
        AHA_HOME_DIR: homeDir,
    };
    vi.resetModules();
    return import('./sessionGenomeMap');
}

describe('sessionGenomeMap', () => {
    afterEach(() => {
        process.env = originalEnv;
        vi.resetModules();
    });

    it('merges append-only updates onto the latest session mapping', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'aha-session-genome-map-'));
        const mapPath = join(homeDir, 'session-genome-map.jsonl');
        const sessionGenomeMap = await loadSessionGenomeMapModule(homeDir);

        sessionGenomeMap.recordSessionGenome({
            sessionId: 'aha-session-1',
            teamId: 'team-1',
            specId: 'spec-1',
            specRef: '@official/implementer:7',
            specVersion: 7,
            runtimeType: 'claude',
            startedAt: 100,
        });

        const merged = sessionGenomeMap.mergeSessionGenome('aha-session-1', {
            claudeSessionId: 'claude-local-1',
        });

        expect(merged).toEqual({
            sessionId: 'aha-session-1',
            claudeSessionId: 'claude-local-1',
            teamId: 'team-1',
            specId: 'spec-1',
            specRef: '@official/implementer:7',
            specVersion: 7,
            runtimeType: 'claude',
            startedAt: 100,
        });
        expect(sessionGenomeMap.lookupSessionGenome('aha-session-1')).toEqual(merged);
        expect(sessionGenomeMap.lookupByClaudeSession('claude-local-1')).toEqual(merged);

        const lines = readFileSync(mapPath, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(2);
    });

    it('can create a fresh mapping via merge once the required fields are present', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'aha-session-genome-map-'));
        const sessionGenomeMap = await loadSessionGenomeMapModule(homeDir);

        expect(sessionGenomeMap.mergeSessionGenome('aha-session-2', {
            codexRolloutId: 'thread-1',
        })).toBeNull();

        const merged = sessionGenomeMap.mergeSessionGenome('aha-session-2', {
            codexRolloutId: 'thread-1',
            teamId: 'team-2',
            specId: 'spec-2',
            specRef: '@official/reviewer:3',
            specVersion: 3,
            runtimeType: 'codex',
            startedAt: 200,
        });

        expect(merged).toEqual({
            sessionId: 'aha-session-2',
            codexRolloutId: 'thread-1',
            teamId: 'team-2',
            specId: 'spec-2',
            specRef: '@official/reviewer:3',
            specVersion: 3,
            runtimeType: 'codex',
            startedAt: 200,
        });
        expect(sessionGenomeMap.lookupByCodexRollout('thread-1')).toEqual(merged);
    });
});
