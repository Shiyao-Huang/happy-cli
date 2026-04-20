import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureCurrentSessionRegisteredToTeam, forceRegisterCurrentSessionToTeam } from './ensureTeamMembership';

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

    it('prefers candidate identity JSON from env when metadata only carries compatibility fields', async () => {
        const getArtifact = vi.fn().mockResolvedValue({
            body: JSON.stringify({ team: { members: [] } }),
        });
        const addTeamMember = vi.fn().mockResolvedValue(undefined);

        vi.stubEnv('AHA_CANDIDATE_IDENTITY_JSON', JSON.stringify({
            candidateId: 'spec:@official/genome-analyst:3',
            specId: '@official/genome-analyst:3',
            basis: 'spec',
        }));

        const result = await ensureCurrentSessionRegisteredToTeam({
            api: {
                getArtifact,
                addTeamMember,
            } as any,
            teamId: 'team-2',
            sessionId: 'session-2',
            role: 'researcher',
            metadata: {
                name: 'Genome Analyst',
                flavor: 'claude',
                executionPlane: 'mainline',
                sessionTag: 'researcher-team-2',
            } as any,
        });

        expect(result).toEqual({ registered: true, alreadyPresent: false });
        expect(addTeamMember).toHaveBeenCalledWith(
            'team-2',
            'session-2',
            'researcher',
            'Genome Analyst',
            expect.objectContaining({
                candidateId: 'spec:@official/genome-analyst:3',
                specId: '@official/genome-analyst:3',
            })
        );
    });

    it('re-registers member when roster memberId points to a stale session id', async () => {
        const getArtifact = vi.fn().mockResolvedValue({
            body: {
                body: JSON.stringify({
                    team: {
                        members: [
                            { memberId: 'member-1', sessionId: 'session-old', roleId: 'master' },
                        ],
                    },
                }),
            },
        });
        const addTeamMember = vi.fn().mockResolvedValue(undefined);

        const result = await ensureCurrentSessionRegisteredToTeam({
            api: {
                getArtifact,
                addTeamMember,
            } as any,
            teamId: 'team-3',
            sessionId: 'session-new',
            role: 'master',
            metadata: {
                memberId: 'member-1',
                name: 'Master 1',
                flavor: 'codex',
            } as any,
        });

        expect(result).toEqual({ registered: true, alreadyPresent: false });
        expect(addTeamMember).toHaveBeenCalledWith(
            'team-3',
            'session-new',
            'master',
            'Master 1',
            expect.objectContaining({
                memberId: 'member-1',
                runtimeType: 'codex',
            })
        );
    });

    it('skips registration when exact session is already in roster', async () => {
        const getArtifact = vi.fn().mockResolvedValue({
            body: {
                body: JSON.stringify({
                    team: {
                        members: [
                            { memberId: 'member-2', sessionId: 'session-4', roleId: 'observer' },
                        ],
                    },
                }),
            },
        });
        const addTeamMember = vi.fn().mockResolvedValue(undefined);

        const result = await ensureCurrentSessionRegisteredToTeam({
            api: {
                getArtifact,
                addTeamMember,
            } as any,
            teamId: 'team-4',
            sessionId: 'session-4',
            role: 'observer',
            metadata: {
                memberId: 'member-2',
                name: 'Observer 1',
                flavor: 'codex',
            } as any,
        });

        expect(result).toEqual({ registered: false, alreadyPresent: true });
        expect(addTeamMember).not.toHaveBeenCalled();
    });

    it('force-registers even when the roster inspection would otherwise be skipped', async () => {
        const addTeamMember = vi.fn().mockResolvedValue(undefined);

        await forceRegisterCurrentSessionToTeam({
            api: {
                addTeamMember,
            } as any,
            teamId: 'team-5',
            sessionId: 'session-5',
            role: 'observer',
            metadata: {
                memberId: 'member-5',
                sessionTag: 'team:team-5:member:member-5',
                name: 'Observer 5',
                flavor: 'codex',
                machineId: 'machine-1',
                host: 'host-1',
            } as any,
        });

        expect(addTeamMember).toHaveBeenCalledWith(
            'team-5',
            'session-5',
            'observer',
            'Observer 5',
            expect.objectContaining({
                memberId: 'member-5',
                sessionTag: 'team:team-5:member:member-5',
                runtimeType: 'codex',
                machineId: 'machine-1',
                machineName: 'host-1',
            })
        );
    });
});
