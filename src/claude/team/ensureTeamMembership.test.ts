import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureCurrentSessionRegisteredToTeam } from './ensureTeamMembership';

describe('ensureCurrentSessionRegisteredToTeam', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('registers bypass executionPlane when present in session metadata', async () => {
        const getArtifact = vi.fn().mockResolvedValue({
            body: JSON.stringify({ team: { members: [] } }),
        });
        const addTeamMember = vi.fn().mockResolvedValue(undefined);

        vi.stubEnv('AHA_CANDIDATE_ID', 'spec:supervisor-1');

        const result = await ensureCurrentSessionRegisteredToTeam({
            api: {
                getArtifact,
                addTeamMember,
            } as any,
            teamId: 'team-1',
            sessionId: 'session-1',
            role: 'supervisor',
            metadata: {
                name: 'Supervisor',
                flavor: 'claude',
                executionPlane: 'bypass',
                sessionTag: 'supervisor-team-1',
            } as any,
        });

        expect(result).toEqual({ registered: true, alreadyPresent: false });
        expect(addTeamMember).toHaveBeenCalledWith(
            'team-1',
            'session-1',
            'supervisor',
            'Supervisor',
            expect.objectContaining({
                candidateId: 'spec:supervisor-1',
                executionPlane: 'bypass',
                runtimeType: 'claude',
            })
        );
    });
});
