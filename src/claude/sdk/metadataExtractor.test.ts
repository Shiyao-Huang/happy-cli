import { describe, expect, it, vi, beforeEach } from 'vitest';

import { extractSDKMetadata } from './metadataExtractor';
import { query } from './query';

vi.mock('./query', () => ({
    query: vi.fn(),
}));

describe('metadataExtractor', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    it('forwards live runtime inputs to the SDK probe', async () => {
        vi.mocked(query).mockReturnValue((async function* () {
            yield {
                type: 'system',
                subtype: 'init',
                tools: ['mcp__aha__get_self_view', 'Bash'],
                slash_commands: ['/compact'],
            };
        })() as any);

        const metadata = await extractSDKMetadata({
            cwd: '/tmp/runtime-worktree',
            allowedTools: ['get_self_view', 'list_visible_tools'],
            disallowedTools: ['kill_agent'],
            permissionMode: 'acceptEdits',
            settingsPath: '/tmp/runtime-worktree/.claude/settings.json',
            strictMcpConfig: true,
            mcpServers: {
                aha: { type: 'http', url: 'http://127.0.0.1:55555' },
            },
        });

        expect(query).toHaveBeenCalledWith({
            prompt: 'hello',
            options: expect.objectContaining({
                cwd: '/tmp/runtime-worktree',
                allowedTools: ['get_self_view', 'list_visible_tools'],
                disallowedTools: ['kill_agent'],
                permissionMode: 'acceptEdits',
                settingsPath: '/tmp/runtime-worktree/.claude/settings.json',
                strictMcpConfig: true,
                mcpServers: {
                    aha: { type: 'http', url: 'http://127.0.0.1:55555' },
                },
                maxTurns: 1,
            }),
        });
        expect(metadata).toEqual({
            tools: ['mcp__aha__get_self_view', 'Bash'],
            slashCommands: ['/compact'],
        });
    });
});
