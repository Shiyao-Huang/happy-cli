import type { ApiClient } from '@/api/api'
import type { Metadata } from '@/api/types'
import { TaskStateManager } from '@/claude/utils/taskStateManager'
import { logger } from '@/ui/logger'

function parseArtifactBoard(artifact: any): Record<string, any> | null {
    if (!artifact) return null

    if (artifact.body && typeof artifact.body === 'object' && 'body' in artifact.body) {
        const bodyValue = (artifact.body as { body?: unknown }).body
        if (typeof bodyValue === 'string') {
            try {
                return JSON.parse(bodyValue)
            } catch {
                return null
            }
        }
        if (bodyValue && typeof bodyValue === 'object') {
            return bodyValue as Record<string, any>
        }
    }

    if (artifact.body && typeof artifact.body === 'object') {
        return artifact.body as Record<string, any>
    }

    return null
}

function hasMember(board: Record<string, any> | null, sessionId: string, memberId?: string): boolean {
    const members = Array.isArray(board?.team?.members) ? board.team.members : []
    return members.some((member: any) => {
        if (memberId && member?.memberId) {
            return member.memberId === memberId
        }
        return member?.sessionId === sessionId
    })
}

export async function ensureCurrentSessionRegisteredToTeam(opts: {
    api: ApiClient
    teamId: string
    sessionId: string
    role: string
    metadata: Metadata
    taskStateManager?: TaskStateManager
}): Promise<{ registered: boolean; alreadyPresent: boolean }> {
    const { api, teamId, sessionId, role, metadata, taskStateManager } = opts

    if (!teamId || !sessionId || !role) {
        return { registered: false, alreadyPresent: false }
    }

    try {
        if (taskStateManager) {
            await taskStateManager.getBoard().catch((error) => {
                logger.debug('[teamMembership] Failed to ensure team artifact before registration:', error)
            })
        }

        try {
            const artifact = await api.getArtifact(teamId)
            const board = parseArtifactBoard(artifact)
            if (hasMember(board, sessionId, metadata.memberId)) {
                return { registered: false, alreadyPresent: true }
            }
        } catch (artifactError) {
            logger.debug('[teamMembership] Could not inspect existing team roster before registration:', artifactError)
        }

        await api.addTeamMember(
            teamId,
            sessionId,
            role,
            metadata.name || `${role}-agent`,
            {
                memberId: metadata.memberId,
                sessionTag: metadata.sessionTag,
                runtimeType: metadata.flavor === 'codex' ? 'codex' : 'claude',
            }
        )

        logger.debug(`[teamMembership] Registered session ${sessionId} to team ${teamId} as ${role}`)
        return { registered: true, alreadyPresent: false }
    } catch (error) {
        logger.debug('[teamMembership] Failed to register current session to team:', error)
        return { registered: false, alreadyPresent: false }
    }
}
