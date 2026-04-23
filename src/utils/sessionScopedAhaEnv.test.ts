import { describe, expect, it } from 'vitest';

import { stripSessionScopedAhaEnv } from './sessionScopedAhaEnv';

describe('stripSessionScopedAhaEnv', () => {
    it('removes session-scoped agent identity while preserving global config', () => {
        const sanitized = stripSessionScopedAhaEnv({
            AHA_SERVER_URL: 'https://aha-agi.com/api',
            AHA_HOME_DIR: '/tmp/.aha',
            AHA_RECOVER_SESSION_ID: 'cmn-stale',
            AHA_ROOM_ID: 'team-old',
            AHA_AGENT_ROLE: 'master',
            AHA_AGENT_PROMPT: 'stale prompt',
            AHA_TEAM_MEMBER_ID: 'member-old',
            CUSTOM_FLAG: 'keep-me',
        });

        expect(sanitized.AHA_SERVER_URL).toBe('https://aha-agi.com/api');
        expect(sanitized.AHA_HOME_DIR).toBe('/tmp/.aha');
        expect(sanitized.CUSTOM_FLAG).toBe('keep-me');
        expect(sanitized.AHA_RECOVER_SESSION_ID).toBeUndefined();
        expect(sanitized.AHA_ROOM_ID).toBeUndefined();
        expect(sanitized.AHA_AGENT_ROLE).toBeUndefined();
        expect(sanitized.AHA_AGENT_PROMPT).toBeUndefined();
        expect(sanitized.AHA_TEAM_MEMBER_ID).toBeUndefined();
    });

    it('optionally strips CLAUDECODE for detached daemon or child spawns', () => {
        const sanitized = stripSessionScopedAhaEnv(
            {
                CLAUDECODE: '1',
                AHA_SERVER_URL: 'https://aha-agi.com/api',
            },
            { stripClaudeCode: true },
        );

        expect(sanitized.CLAUDECODE).toBeUndefined();
        expect(sanitized.AHA_SERVER_URL).toBe('https://aha-agi.com/api');
    });
});
