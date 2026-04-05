import { describe, expect, it } from 'vitest';
import {
    buildEffectivePermissionsReport,
    buildRuntimePermissionSnapshot,
    canInspectGenomeSpec,
    collectRuntimeVisibleTools,
    explainRuntimeToolAccess,
    extractTeamConfigSnapshot,
} from './inspectionTools';

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

        expect(report.visibleTools).toBeNull();
        expect(report.hiddenTools).toBeNull();
        expect(report.warnings).toEqual([]);
        expect(report.capabilityComputation).toBe('derived');
        expect(report.capabilityInputs).toEqual(expect.arrayContaining(['rolePredicates']));
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

        expect(report.allowedTools).toEqual(['edit', 'bash']);
        expect(report.deniedTools).toEqual(['spawn_session']);
    });

    it('grants agent.spawn to legacy @official/master v2 via the compatibility shim', () => {
        const report = buildEffectivePermissionsReport({
            sessionId: 'sess-legacy-master',
            role: 'master',
            teamId: 'team-legacy',
            specId: 'cmn2x7oj00003atpevpyhp45k',
            permissionMode: 'plan',
            allowedTools: ['list_tasks', 'create_task', 'create_agent'],
            deniedTools: ['spawn_session'],
            genomeSpec: {
                namespace: '@official',
                name: 'master',
                baseRoleId: 'master',
                version: 2,
                behavior: { canSpawnAgents: false },
                authorities: ['task.create', 'task.assign', 'task.update.any'],
            } as any,
            memberAuthorities: [],
            teamOverlayAuthorities: [],
        });

        expect(report.grantedCapabilities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    capability: 'agent.spawn',
                    source: 'rolePredicates.canSpawnAgents(master)=true',
                }),
            ]),
        );

        expect(report.permissionMode).toBe('plan');
    });
});

describe('runtime self-inspection helpers', () => {
    it('allows qa roles to inspect @official and same-team specs while keeping worker self-inspection', () => {
        expect(canInspectGenomeSpec({
            callerRole: 'qa-engineer',
            callerSpecId: 'spec-qa',
            targetSpecId: 'spec-other',
            targetNamespace: '@official',
        })).toBe(true);

        expect(canInspectGenomeSpec({
            callerRole: 'qa',
            callerSpecId: 'spec-qa',
            targetSpecId: 'spec-other',
            targetNamespace: '@team-private',
            targetBelongsToCallerTeam: true,
        })).toBe(true);

        expect(canInspectGenomeSpec({
            callerRole: 'implementer',
            callerSpecId: 'spec-self',
            targetSpecId: 'spec-self',
        })).toBe(true);
    });

    it('denies qa roles from inspecting cross-team private specs', () => {
        expect(canInspectGenomeSpec({
            callerRole: 'qa-engineer',
            callerSpecId: 'spec-qa',
            targetSpecId: 'spec-other',
            targetNamespace: '@team-b',
            targetBelongsToCallerTeam: false,
        })).toBe(false);

        expect(canInspectGenomeSpec({
            callerRole: 'qa',
            callerSpecId: 'spec-qa',
            targetSpecId: 'spec-other',
            targetNamespace: null,
        })).toBe(false);
    });

    it('keeps non-qa non-coordinator roles from inspecting other genome specs', () => {
        expect(canInspectGenomeSpec({
            callerRole: 'reviewer',
            callerSpecId: 'spec-reviewer',
            targetSpecId: 'spec-other',
        })).toBe(false);

        expect(canInspectGenomeSpec({
            callerRole: 'implementer',
            callerSpecId: 'spec-impl',
            targetSpecId: 'spec-other',
        })).toBe(false);
    });

    it('normalizes visible MCP tool names from session metadata', () => {
        const visible = collectRuntimeVisibleTools({
            path: '/tmp',
            host: 'test-host',
            tools: ['mcp__aha__get_self_view', 'Bash', 'mcp__aha__get_self_view'],
        });

        expect(visible).toEqual([
            { rawName: 'Bash', name: 'Bash', surface: 'native' },
            { rawName: 'mcp__aha__get_self_view', name: 'get_self_view', surface: 'mcp' },
        ]);
    });

    it('builds runtime permission snapshot from metadata without static guessing', () => {
        const snapshot = buildRuntimePermissionSnapshot({
            path: '/tmp',
            host: 'test-host',
            tools: ['mcp__aha__get_self_view', 'mcp__aha__list_tasks'],
            runtimePermissions: {
                source: 'claude-runtime',
                permissionMode: 'acceptEdits',
                allowedTools: ['get_self_view', 'list_tasks', 'create_task'],
                disallowedTools: ['kill_agent'],
            },
        });

        expect(snapshot.permissionMode).toBe('acceptEdits');
        expect(snapshot.allowedTools).toEqual(['get_self_view', 'list_tasks', 'create_task']);
        expect(snapshot.deniedTools).toEqual(['kill_agent']);
        expect(snapshot.visibleTools).toEqual(['get_self_view', 'list_tasks']);
        expect(snapshot.hiddenTools).toEqual(['create_task']);
        expect(snapshot.warnings).toEqual([]);
    });

    it('keeps allowlist and denylist unknown when the runtime does not surface them', () => {
        const snapshot = buildRuntimePermissionSnapshot({
            path: '/tmp',
            host: 'test-host',
            runtimePermissions: {
                source: 'codex-runtime',
                permissionMode: 'bypassPermissions',
            },
        });

        expect(snapshot.permissionMode).toBe('bypassPermissions');
        expect(snapshot.allowlistKnown).toBe(false);
        expect(snapshot.denylistKnown).toBe(false);
        expect(snapshot.allowedTools).toBeNull();
        expect(snapshot.deniedTools).toBeNull();
        expect(snapshot.hiddenTools).toBeNull();
        expect(snapshot.warnings).toEqual(expect.arrayContaining([
            'Visible tool inventory unavailable in session metadata.',
            'Runtime allowlist snapshot unavailable in session metadata.',
            'Runtime denylist snapshot unavailable in session metadata.',
        ]));
    });

    it('explains hidden, denied, and unknown tool states distinctly', () => {
        const snapshot = buildRuntimePermissionSnapshot({
            path: '/tmp',
            host: 'test-host',
            tools: ['mcp__aha__get_self_view'],
            runtimePermissions: {
                source: 'claude-runtime',
                permissionMode: 'acceptEdits',
                allowedTools: ['get_self_view', 'create_task'],
                disallowedTools: ['kill_agent'],
            },
        });

        expect(explainRuntimeToolAccess('get_self_view', snapshot)).toMatchObject({
            status: 'visible',
            visible: true,
            allowlisted: true,
            denied: false,
        });

        expect(explainRuntimeToolAccess('create_task', snapshot)).toMatchObject({
            status: 'hidden_by_allowlist',
            visible: false,
            allowlisted: true,
            denied: false,
        });

        expect(explainRuntimeToolAccess('kill_agent', snapshot)).toMatchObject({
            status: 'denied',
            denied: true,
        });

        expect(explainRuntimeToolAccess('read_team_log', buildRuntimePermissionSnapshot({
            path: '/tmp',
            host: 'test-host',
        }))).toMatchObject({
            status: 'unknown',
            visible: null,
            allowlisted: null,
            denied: null,
        });
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
