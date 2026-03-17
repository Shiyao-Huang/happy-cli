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
