import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAgentLaunchContext } from './agentLaunchContext';

describe('buildAgentLaunchContext', () => {
    it('builds a concrete scope summary from repo structure and guidance files', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-launch-context-'));
        mkdirSync(join(root, 'aha-cli', 'src'), { recursive: true });
        mkdirSync(join(root, 'kanban'), { recursive: true });
        mkdirSync(join(root, 'happy-server'), { recursive: true });
        writeFileSync(join(root, 'SYSTEM.md'), '# system', 'utf-8');
        writeFileSync(join(root, 'AGENTS.md'), '# agents', 'utf-8');

        const result = buildAgentLaunchContext({
            directory: join(root, 'aha-cli'),
            existingPrompt: 'Implement the assigned task.',
            includeTeamHelpLane: true,
        });

        expect(result.scopeSummary).toContain('Primary write scope: aha-cli/**');
        expect(result.scopeSummary).toContain('kanban/**');
        expect(result.scopeSummary).toContain('happy-server/**');
        expect(result.prompt).toContain('Implement the assigned task.');
        expect(result.prompt).toContain('Read first:');
        expect(result.prompt).toContain('request_help');
        expect(result.prompt).toContain('@help');
        expect(result.prompt).toContain('get_context_status');
        expect(result.guidanceFiles).toHaveLength(2);
    });

    it('falls back gracefully when no guidance files are present', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-launch-context-empty-'));
        mkdirSync(join(root, 'repo', 'src'), { recursive: true });

        const result = buildAgentLaunchContext({
            directory: join(root, 'repo', 'src'),
        });

        expect(result.scopeSummary).toContain('Primary write scope:');
        expect(result.prompt).toContain('nearest SYSTEM.md / AGENTS.md');
        expect(result.guidanceFiles).toEqual([]);
    });
});
