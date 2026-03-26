import { describe, expect, it } from 'vitest'

import { projectSelfMirrorIdentity, projectTeamAgentMirror } from './runEnvelopeMirror'

describe('runEnvelopeMirror', () => {
    it('projects self identity from RunEnvelope fact fields first', () => {
        const projected = projectSelfMirrorIdentity({
            sessionId: 'session-1',
            role: 'implementer',
            metaCandidateId: 'meta-candidate',
            metaSpecId: 'meta-spec',
            metaMemberId: 'meta-member',
            metaExecutionPlane: 'mainline',
            metaRuntimeType: 'codex',
            envelope: {
                runId: 'run-1',
                sessionId: 'session-1',
                pid: 123,
                status: 'active',
                teamId: 'team-1',
                memberId: 'member-1',
                role: 'implementer',
                runtimeType: 'claude',
                executionPlane: 'bypass',
                candidateId: 'spec:spec-1',
                specId: 'spec-1',
                sessionTag: null,
                parentSessionId: null,
                sessionPath: '/repo',
                contextPrior: {
                    sessionName: 'Impl',
                    promptSummary: 'Fix bug',
                    startedBy: 'daemon',
                },
                spawnedAt: '2026-03-26T15:00:00.000Z',
                updatedAt: '2026-03-26T15:00:01.000Z',
            },
        })

        expect(projected).toEqual({
            sessionId: 'session-1',
            runId: 'run-1',
            role: 'implementer',
            candidateId: 'spec:spec-1',
            specId: 'spec-1',
            memberId: 'member-1',
            executionPlane: 'bypass',
            runtimeType: 'claude',
            runStatus: 'active',
            spawnedAt: '2026-03-26T15:00:00.000Z',
        })
    })

    it('falls back to member and session metadata when envelope is absent', () => {
        const projected = projectTeamAgentMirror({
            sessionId: 'session-2',
            member: {
                candidateId: 'member-candidate',
                specId: 'member-spec',
                memberId: 'member-2',
                executionPlane: 'mainline',
                runtimeType: 'codex',
            },
            sessionSnapshot: {
                metadata: {
                    candidateId: 'snapshot-candidate',
                    specId: 'snapshot-spec',
                    memberId: 'snapshot-member',
                    flavor: 'claude',
                },
            },
            envelope: null,
            defaultExecutionPlane: 'mainline',
            defaultRuntimeType: 'claude',
        })

        expect(projected).toEqual({
            sessionId: 'session-2',
            candidateId: 'member-candidate',
            specId: 'member-spec',
            memberId: 'member-2',
            runId: 'session-2',
            runStatus: null,
            spawnedAt: null,
            executionPlane: 'mainline',
            runtimeType: 'codex',
        })
    })
})
