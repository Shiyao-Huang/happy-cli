import { describe, expect, it } from 'vitest';
import { buildEffectivePermissionsReport, extractTeamConfigSnapshot } from './inspectionTools';

describe('buildEffectivePermissionsReport', () => {
    it('grants task.create to coordinator roles while denying agent.spawn when genome explicitly disables it', () => {
        const report = buildEffectivePermissionsReport({
            sessionId: 'sess-1',
            role: 'master',
            teamId: 'team-1',
            specId: 'spec-1',
            permissionMode: 'plan',
            allowedTools: ['list_tasks', 'create_task'],
            deniedTools: ['spawn_session'],
            genomeSpec: {
                behavior: { canSpawnAgents: false },
                authorities: [],
            },
            memberAuthorities: [],
            teamOverlayAuthorities: [],
        });

        expect(report.grantedCapabilities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    capability: 'task.create',
                    source: 'rolePredicates.isCoordinatorRole(master)=true',
                }),
                expect.objectContaining({
                    capability: 'agent.replace',
                    source: 'tool role gate allows master',
                }),
            ]),
        );

        expect(report.deniedCapabilities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    capability: 'agent.spawn',
                    source: 'genome.behavior.canSpawnAgents=false',
                }),
                expect.objectContaining({
                    capability: 'session.archive',
                    source: 'tool role gate denies master',
                }),
            ]),
        );
    });

    it('returns explicit denial metadata for non-governance worker roles', () => {
        const report = buildEffectivePermissionsReport({
            sessionId: 'sess-2',
            role: 'implementer',
            teamId: 'team-1',
            specId: null,
            permissionMode: 'yolo',
            allowedTools: ['edit', 'bash'],
            deniedTools: ['spawn_session'],
            genomeSpec: null,
            memberAuthorities: [],
            teamOverlayAuthorities: [],
        });

        expect(report.deniedCapabilities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    capability: 'task.create',
                    remediation: expect.stringContaining('task.create'),
                    escalateTo: expect.arrayContaining(['master']),
                }),
                expect.objectContaining({
                    capability: 'agent.replace',
                    remediation: expect.stringContaining('supervisor'),
                }),
            ]),
        );
    });
});

describe('extractTeamConfigSnapshot', () => {
    it('returns a compact config snapshot from team board data', () => {
        const snapshot = extractTeamConfigSnapshot('team-1', {
            version: 49,
            team: {
                name: '上线部署',
            },
            roles: [
                { id: 'master', title: 'Master Coordinator' },
                { id: 'implementer', title: 'Implementer', version: 2 },
            ],
            agreements: {
                statusUpdates: 'Every agent posts status updates.',
            },
            bootContext: {
                teamDescription: 'gstack驱动的全栈开发团队',
            },
        });

        expect(snapshot).toEqual({
            teamId: 'team-1',
            name: '上线部署',
            description: 'gstack驱动的全栈开发团队',
            roles: [
                { id: 'master', title: 'Master Coordinator', version: null },
                { id: 'implementer', title: 'Implementer', version: 2 },
            ],
            agreements: {
                statusUpdates: 'Every agent posts status updates.',
            },
            bootContext: {
                teamDescription: 'gstack驱动的全栈开发团队',
            },
            templateVersion: 49,
        });
    });
});
