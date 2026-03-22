import { randomUUID } from 'node:crypto';

export function buildTeamMemberSessionTag(teamId: string, memberId: string) {
    return `team:${teamId}:member:${memberId}`;
}

export function createTeamMemberIdentity(teamId: string, memberId: string = randomUUID()) {
    return {
        memberId,
        sessionTag: buildTeamMemberSessionTag(teamId, memberId),
    };
}

export function createReplacementTeamMemberIdentity(teamId: string, previousMemberId?: string) {
    let identity = createTeamMemberIdentity(teamId);
    while (previousMemberId && identity.memberId === previousMemberId) {
        identity = createTeamMemberIdentity(teamId);
    }
    return identity;
}
