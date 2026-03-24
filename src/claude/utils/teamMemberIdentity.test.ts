import { describe, expect, it } from 'vitest';
import { buildTeamMemberSessionTag, createReplacementTeamMemberIdentity, createTeamMemberIdentity } from './teamMemberIdentity';

describe('buildTeamMemberSessionTag', () => {
    it('builds the canonical team member session tag', () => {
        expect(buildTeamMemberSessionTag('team-123', 'member-456')).toBe('team:team-123:member:member-456');
    });
});

describe('createTeamMemberIdentity', () => {
    it('returns memberId and sessionTag together so callers cannot forget either field', () => {
        expect(createTeamMemberIdentity('team-123', 'member-456')).toEqual({
            memberId: 'member-456',
            sessionTag: 'team:team-123:member:member-456',
        });
    });

    it('generates a memberId when one is not provided', () => {
        const identity = createTeamMemberIdentity('team-123');
        expect(identity.memberId).toBeTruthy();
        expect(identity.sessionTag).toBe(`team:team-123:member:${identity.memberId}`);
    });
});

describe('createReplacementTeamMemberIdentity', () => {
    it('generates a fresh identity for replacements instead of reusing the previous member tag', () => {
        const identity = createReplacementTeamMemberIdentity('team-123', 'member-456');
        expect(identity.memberId).toBeTruthy();
        expect(identity.memberId).not.toBe('member-456');
        expect(identity.sessionTag).toBe(`team:team-123:member:${identity.memberId}`);
    });
});
