import type { RunEnvelope } from '@/daemon/runEnvelope'

export type SelfMirrorIdentity = {
    sessionId: string
    runId: string
    role: string
    candidateId: string | null
    specId: string | null
    memberId: string | null
    executionPlane: string
    runtimeType: string | null
    runStatus: RunEnvelope['status'] | null
    spawnedAt: string | null
}

export function projectSelfMirrorIdentity(args: {
    sessionId: string
    role: string
    metaCandidateId?: string | null
    metaSpecId?: string | null
    metaMemberId?: string | null
    metaExecutionPlane?: string | null
    metaRuntimeType?: string | null
    envelope?: RunEnvelope | null
}): SelfMirrorIdentity {
    const specId = args.envelope?.specId || args.metaSpecId || null

    return {
        sessionId: args.sessionId,
        runId: args.envelope?.runId || args.sessionId,
        role: args.role,
        candidateId: args.envelope?.candidateId || args.metaCandidateId || (specId ? `spec:${specId}` : null),
        specId,
        memberId: args.envelope?.memberId || args.metaMemberId || null,
        executionPlane: args.envelope?.executionPlane || args.metaExecutionPlane || 'mainline',
        runtimeType: args.envelope?.runtimeType || args.metaRuntimeType || null,
        runStatus: args.envelope?.status || null,
        spawnedAt: args.envelope?.spawnedAt || null,
    }
}

export type TeamAgentMirror = {
    sessionId: string
    candidateId: string | null
    specId: string | null
    memberId: string | null
    runId: string
    runStatus: RunEnvelope['status'] | null
    spawnedAt: string | null
    executionPlane: string
    runtimeType: string
}

export function projectTeamAgentMirror(args: {
    sessionId: string
    member?: Record<string, any>
    sessionSnapshot?: { metadata?: Record<string, any> | null } | null
    envelope?: RunEnvelope | null
    defaultExecutionPlane?: string
    defaultRuntimeType?: string
}): TeamAgentMirror {
    const specId = args.envelope?.specId || args.member?.specId || args.sessionSnapshot?.metadata?.specId || null
    return {
        sessionId: args.sessionId,
        candidateId: args.envelope?.candidateId || args.member?.candidateId || args.sessionSnapshot?.metadata?.candidateId || (specId ? `spec:${specId}` : null),
        specId,
        memberId: args.envelope?.memberId || args.member?.memberId || args.sessionSnapshot?.metadata?.memberId || null,
        runId: args.envelope?.runId || args.sessionId,
        runStatus: args.envelope?.status || null,
        spawnedAt: args.envelope?.spawnedAt || null,
        executionPlane: args.envelope?.executionPlane || args.member?.executionPlane || args.defaultExecutionPlane || 'mainline',
        runtimeType: args.envelope?.runtimeType || args.member?.runtimeType || args.sessionSnapshot?.metadata?.flavor || args.defaultRuntimeType || 'claude',
    }
}
