import { describe, expect, it } from 'vitest';

import { buildTeamRosterView } from './teamTools';

describe('buildTeamRosterView', () => {
    it('filters inactive artifact-only members by default when pulse truth is known', () => {
        const view = buildTeamRosterView({
            boardMembers: [
                { sessionId: 'sess-master', roleId: 'master', displayName: 'Master' },
                { sessionId: 'sess-dead', roleId: 'builder', displayName: 'Old Builder' },
            ],
            headerSessions: ['sess-master', 'sess-dead'],
            pulseMembers: [
                { sessionId: 'sess-master', role: 'master', status: 'alive', lastSeenMs: 500 },
                { sessionId: 'sess-live-review', role: 'reviewer', status: 'suspect', lastSeenMs: 15_000 },
            ],
            mySessionId: 'sess-master',
        });

        expect(view.pulseKnown).toBe(true);
        expect(view.activeFilterApplied).toBe(true);
        expect(view.counts.totalKnown).toBe(3);
        expect(view.counts.collaborating).toBe(2);
        expect(view.counts.inactive).toBe(1);
        expect(view.members.map((member) => member.sessionId)).toEqual(['sess-master', 'sess-live-review']);
    });

    it('returns inactive members when an explicit detailed view is requested', () => {
        const view = buildTeamRosterView({
            boardMembers: [
                { sessionId: 'sess-master', roleId: 'master', displayName: 'Master' },
                { sessionId: 'sess-dead', roleId: 'builder', displayName: 'Old Builder' },
            ],
            headerSessions: ['sess-master', 'sess-dead'],
            pulseMembers: [
                { sessionId: 'sess-master', role: 'master', status: 'alive', lastSeenMs: 500 },
            ],
            mySessionId: 'sess-master',
            includeInactive: true,
        });

        expect(view.activeFilterApplied).toBe(false);
        expect(view.members.map((member) => ({
            sessionId: member.sessionId,
            liveness: member.liveness,
        }))).toEqual([
            { sessionId: 'sess-master', liveness: 'alive' },
            { sessionId: 'sess-dead', liveness: 'inactive' },
        ]);
    });

    it('keeps unknown members visible when pulse truth is unavailable', () => {
        const view = buildTeamRosterView({
            boardMembers: [
                { sessionId: 'sess-master', roleId: 'master', displayName: 'Master' },
                { sessionId: 'sess-unknown', roleId: 'reviewer', displayName: 'Reviewer' },
            ],
            headerSessions: ['sess-master', 'sess-unknown'],
            pulseMembers: null,
            mySessionId: 'sess-master',
        });

        expect(view.pulseKnown).toBe(false);
        expect(view.activeFilterApplied).toBe(false);
        expect(view.counts.unknown).toBe(1);
        expect(view.members.map((member) => ({
            sessionId: member.sessionId,
            liveness: member.liveness,
        }))).toEqual([
            { sessionId: 'sess-master', liveness: 'alive' },
            { sessionId: 'sess-unknown', liveness: 'unknown' },
        ]);
    });
});
