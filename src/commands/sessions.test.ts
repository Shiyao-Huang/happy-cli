import { describe, expect, it } from 'vitest';

import { resolveSessionTeamId } from './sessions';

describe('resolveSessionTeamId', () => {
    it('prefers metadata.teamId when present', () => {
        expect(resolveSessionTeamId({ teamId: 'team-1', roomId: 'room-1' })).toBe('team-1');
    });

    it('falls back to metadata.roomId for older team sessions', () => {
        expect(resolveSessionTeamId({ roomId: 'room-1' })).toBe('room-1');
    });

    it('returns undefined when no team metadata exists', () => {
        expect(resolveSessionTeamId({})).toBeUndefined();
    });
});
