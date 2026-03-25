import { randomUUID } from 'node:crypto'
import {
    boundarySnapshotSchema,
    collectionLogEntrySchema,
    environmentSnapshotSchema,
    identitySnapshotSchema,
    limitationsSnapshotSchema,
    reflexivityFixtureSchema,
    taskSnapshotSchema,
    toolSnapshotSchema,
    toolStateSchema,
    type BoundarySnapshot,
    type CollectionLogEntry,
    type EnvironmentSnapshot,
    type IdentitySnapshot,
    type LimitationsSnapshot,
    type ReflexivityFixture,
    type TaskSnapshot,
    type ToolAccessMode,
    type ToolSnapshot,
    type ToolState,
} from './schema'

type PartialRecord<T> = { [K in keyof T]?: T[K] }

export type BuildReflexivityFixtureInput = {
    fixtureId?: string
    collectedAt?: number
    context?: Partial<Record<'teamId' | 'sessionId' | 'runtimeType', string | null>>
    raw?: {
        selfViewText?: string | null
        teamInfoText?: string | null
        teamConfigOutput?: string | Record<string, unknown> | null
        spawnBoundaryContextText?: string | null
        toolProbes?: Record<string, Partial<ToolState>>
    }
    snapshots?: {
        identitySnapshot?: Partial<IdentitySnapshot>
        taskSnapshot?: Partial<TaskSnapshot>
        environmentSnapshot?: Partial<EnvironmentSnapshot>
        toolSnapshot?: Partial<ToolSnapshot>
        boundarySnapshot?: Partial<BoundarySnapshot>
        limitationsSnapshot?: Partial<LimitationsSnapshot>
        artifactSnapshot?: Partial<ReflexivityFixture['artifactSnapshot']>
    }
    collectionLog?: CollectionLogEntry[]
}

export type ParsedSelfView = {
    sessionId: string | null
    role: string | null
    genomeName: string | null
    genomeDescription: string | null
    responsibilities: string[]
    teamId: string | null
    runtimeType: string | null
}

export type ParsedTeamInfo = {
    sessionId: string | null
    role: string | null
    responsibilities: string[]
    boundaries: string[]
    teamId: string | null
}

export type ParsedTeamConfig = {
    teamId: string | null
    name: string | null
    description: string | null
    agreements: Record<string, unknown> | null
    bootContext: Record<string, unknown> | null
}

function normalizeLines(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
}

function extractBulletList(lines: string[], header: string): string[] {
    const index = lines.findIndex((line) => line === header)
    if (index < 0) return []

    const items: string[] = []
    for (let i = index + 1; i < lines.length; i += 1) {
        const line = lines[i]
        if (line.startsWith('## ')) break
        if (line.startsWith('- ')) {
            items.push(line.slice(2).trim())
        }
    }
    return items
}

function readInlineField(lines: string[], label: string): string | null {
    const line = lines.find((entry) => entry.startsWith(label))
    if (!line) return null
    return line.slice(label.length).trim() || null
}

export function parseSelfView(text: string): ParsedSelfView {
    const lines = normalizeLines(text)
    const responsibilitiesRaw = readInlineField(lines, 'Responsibilities:')
    const responsibilities = responsibilitiesRaw
        ? responsibilitiesRaw.split(',').map((item) => item.trim()).filter(Boolean)
        : []

    const teamHeader = lines.find((line) => line.startsWith('[Team:'))
    const teamId = teamHeader ? teamHeader.replace(/^\[Team:\s*/, '').replace(/\]$/, '').trim() : null
    const runtimeLine = lines.find((line) => line.includes('(YOU):'))
    const runtimeMatch = runtimeLine?.match(/\[(.+?)\]\s*$/)

    return {
        sessionId: readInlineField(lines, 'Session:'),
        role: readInlineField(lines, 'Role:'),
        genomeName: readInlineField(lines, 'Genome:'),
        genomeDescription: readInlineField(lines, 'Description:'),
        responsibilities,
        teamId,
        runtimeType: runtimeMatch?.[1] ?? null,
    }
}

export function parseTeamInfo(text: string): ParsedTeamInfo {
    const lines = normalizeLines(text)
    return {
        sessionId: readInlineField(lines, '- **Session ID**:'),
        role: readInlineField(lines, '- **Role**:'),
        responsibilities: extractBulletList(lines, '## Your Responsibilities'),
        boundaries: extractBulletList(lines, '## Your Boundaries'),
        teamId: readInlineField(lines, '**Team ID**:'),
    }
}

export function parseTeamConfigOutput(input: string | Record<string, unknown> | null | undefined): ParsedTeamConfig {
    if (!input) {
        return {
            teamId: null,
            name: null,
            description: null,
            agreements: null,
            bootContext: null,
        }
    }

    const value = typeof input === 'string' ? JSON.parse(input) as Record<string, unknown> : input
    return {
        teamId: typeof value.teamId === 'string' ? value.teamId : null,
        name: typeof value.name === 'string' ? value.name : null,
        description: typeof value.description === 'string' ? value.description : null,
        agreements: value.agreements && typeof value.agreements === 'object' ? value.agreements as Record<string, unknown> : null,
        bootContext: value.bootContext && typeof value.bootContext === 'object' ? value.bootContext as Record<string, unknown> : null,
    }
}

function extractSpawnBoundaryBlock(text: string): string {
    const marker = '## Spawn-Time Boundary Context'
    const start = text.indexOf(marker)
    if (start < 0) return text.trim()
    return text.slice(start).trim()
}

function extractBulletValue(block: string, label: string): string | null {
    const lines = normalizeLines(block)
    const prefix = `- ${label}`
    const line = lines.find((entry) => entry.startsWith(prefix))
    if (!line) return null
    return line.slice(prefix.length).trim() || null
}

function splitCsvLike(value: string | null, separator: ';' | ','): string[] {
    if (!value) return []
    return value.split(separator).map((item) => item.trim()).filter(Boolean)
}

function inferHelpLaneTokens(value: string | null): string[] {
    if (!value) return []
    const tokens = new Set<string>()
    if (value.includes('request_help')) tokens.add('request_help')
    if (value.includes('@help')) tokens.add('@help')
    if (value.includes('team chat') || value.includes('team message') || value.includes('send_team_message')) tokens.add('send_team_message')
    return Array.from(tokens)
}

export function parseSpawnBoundaryContext(text: string): BoundarySnapshot {
    const block = extractSpawnBoundaryBlock(text)
    const boundary = boundarySnapshotSchema.parse({
        readFirst: splitCsvLike(extractBulletValue(block, 'Read first:'), ';'),
        primaryWriteScope: extractBulletValue(block, 'Primary write scope:'),
        avoidScopes: splitCsvLike(extractBulletValue(block, 'Avoid sibling project trees unless explicitly assigned:'), ','),
        readOnlyDocs: splitCsvLike(extractBulletValue(block, 'Guidance docs are read-only context unless explicitly assigned:'), ','),
        helpLane: inferHelpLaneTokens(extractBulletValue(block, 'Help lane:')),
        contextMirrorRule: extractBulletValue(block, 'Context mirror:'),
        rawSpawnContext: block || null,
    })

    return boundary
}

export function buildToolState(name: string, input: Partial<ToolState> = {}): ToolState {
    const declaredAvailable = input.declaredAvailable ?? true
    const accessMode = (input.accessMode ?? 'unknown') as ToolAccessMode
    let status = input.status

    if (!status) {
        if (accessMode === 'permission_denied') {
            status = 'permission_denied'
        } else if (input.error) {
            status = accessMode === 'precondition_required' ? 'unavailable' : 'failed'
        } else if (input.value !== undefined && input.value !== null) {
            status = 'ok'
        } else if (accessMode === 'precondition_required') {
            status = 'unavailable'
        } else {
            status = 'not_probed'
        }
    }

    return toolStateSchema.parse({
        declaredAvailable,
        declaredSource: input.declaredSource ?? 'case_fixture',
        accessMode,
        status,
        value: input.value ?? null,
        error: input.error ?? null,
        probedAt: input.probedAt,
        rawRef: input.rawRef,
    })
}

function mergeIdentitySnapshots(base: IdentitySnapshot, next: Partial<IdentitySnapshot>, log: CollectionLogEntry[]): IdentitySnapshot {
    const merged: IdentitySnapshot = {
        ...base,
        ...next,
        responsibilities: next.responsibilities ?? base.responsibilities,
        sources: {
            ...(base.sources ?? {}),
            ...(next.sources ?? {}),
        },
    }

    if (base.role && next.role && base.role !== next.role) {
        log.push(collectionLogEntrySchema.parse({
            step: 'identity:role-conflict',
            status: 'conflict',
            message: `Conflicting role values: ${base.role} vs ${next.role}`,
            recordedAt: Date.now(),
        }))
    }

    return merged
}

function defaultCollectionLog(input: CollectionLogEntry[] | undefined): CollectionLogEntry[] {
    return (input ?? []).map((entry) => collectionLogEntrySchema.parse(entry))
}

function inferLimitations(toolSnapshot: ToolSnapshot, boundarySnapshot: BoundarySnapshot, existing: Partial<LimitationsSnapshot> | undefined): LimitationsSnapshot {
    const active = new Set(existing?.active ?? [])
    const needsEvidence = new Set(existing?.needsEvidence ?? [])
    const unblockOptions = new Set(existing?.unblockOptions ?? [])
    const derivedFrom = new Set(existing?.derivedFrom ?? [])

    for (const [toolName, tool] of Object.entries(toolSnapshot.tools)) {
        if (tool.status === 'failed') {
            active.add(`${toolName} failed: ${tool.error ?? 'unknown error'}`)
            needsEvidence.add(`need successful probe for ${toolName}`)
            derivedFrom.add(toolName)
        }
        if (tool.status === 'unavailable') {
            active.add(`${toolName} unavailable`)
            derivedFrom.add(toolName)
        }
        if (tool.status === 'permission_denied') {
            active.add(`${toolName} permission denied`)
            needsEvidence.add(`need authorized caller or different role for ${toolName}`)
            derivedFrom.add(toolName)
        }
    }

    for (const token of boundarySnapshot.helpLane) {
        unblockOptions.add(token)
    }

    return limitationsSnapshotSchema.parse({
        active: Array.from(active),
        needsEvidence: Array.from(needsEvidence),
        unblockOptions: Array.from(unblockOptions),
        derivedFrom: Array.from(derivedFrom),
    })
}

export function buildReflexivityFixture(input: BuildReflexivityFixtureInput = {}): ReflexivityFixture {
    const collectedAt = input.collectedAt ?? Date.now()
    const log = defaultCollectionLog(input.collectionLog)

    const parsedSelfView = input.raw?.selfViewText ? parseSelfView(input.raw.selfViewText) : null
    const parsedTeamInfo = input.raw?.teamInfoText ? parseTeamInfo(input.raw.teamInfoText) : null
    const parsedTeamConfig = input.raw?.teamConfigOutput ? parseTeamConfigOutput(input.raw.teamConfigOutput) : null
    const parsedBoundary = input.raw?.spawnBoundaryContextText ? parseSpawnBoundaryContext(input.raw.spawnBoundaryContextText) : boundarySnapshotSchema.parse({})

    let identity = identitySnapshotSchema.parse({})
    if (parsedSelfView) {
        identity = mergeIdentitySnapshots(identity, {
            sessionId: parsedSelfView.sessionId,
            role: parsedSelfView.role,
            genomeName: parsedSelfView.genomeName,
            genomeDescription: parsedSelfView.genomeDescription,
            teamId: parsedSelfView.teamId,
            runtimeType: parsedSelfView.runtimeType,
            responsibilities: parsedSelfView.responsibilities,
            sources: {
                sessionId: { source: 'get_self_view', collectedAt, confidence: 'high' },
                role: { source: 'get_self_view', collectedAt, confidence: 'high' },
                genomeName: { source: 'get_self_view', collectedAt, confidence: 'medium' },
                genomeDescription: { source: 'get_self_view', collectedAt, confidence: 'medium' },
                teamId: { source: 'get_self_view', collectedAt, confidence: 'high' },
                runtimeType: { source: 'get_self_view', collectedAt, confidence: 'medium' },
            },
        }, log)
    }

    if (parsedTeamInfo) {
        identity = mergeIdentitySnapshots(identity, {
            sessionId: identity.sessionId ?? parsedTeamInfo.sessionId,
            role: identity.role ?? parsedTeamInfo.role,
            responsibilities: identity.responsibilities.length > 0 ? identity.responsibilities : parsedTeamInfo.responsibilities,
            teamId: identity.teamId ?? parsedTeamInfo.teamId,
        }, log)
    }

    if (parsedTeamConfig) {
        identity = mergeIdentitySnapshots(identity, {
            teamId: identity.teamId ?? parsedTeamConfig.teamId,
            teamName: parsedTeamConfig.name,
        }, log)
    }

    if (input.context) {
        identity = mergeIdentitySnapshots(identity, {
            sessionId: identity.sessionId ?? input.context.sessionId ?? null,
            teamId: identity.teamId ?? input.context.teamId ?? null,
            runtimeType: identity.runtimeType ?? input.context.runtimeType ?? null,
        }, log)
    }

    identity = mergeIdentitySnapshots(identity, input.snapshots?.identitySnapshot ?? {}, log)

    const toolEntries = Object.entries(input.raw?.toolProbes ?? {}).reduce<Record<string, ToolState>>((acc, [name, tool]) => {
        acc[name] = buildToolState(name, tool)
        return acc
    }, {})
    const toolSnapshot = toolSnapshotSchema.parse({
        tools: {
            ...toolEntries,
            ...(input.snapshots?.toolSnapshot?.tools ?? {}),
        },
    })

    const boundarySnapshot = boundarySnapshotSchema.parse({
        ...parsedBoundary,
        ...(input.snapshots?.boundarySnapshot ?? {}),
    })

    const environmentSnapshot = environmentSnapshotSchema.parse({
        guidanceFiles: boundarySnapshot.readFirst,
        ...(input.snapshots?.environmentSnapshot ?? {}),
    })

    const taskSnapshot = taskSnapshotSchema.parse({
        ...(input.snapshots?.taskSnapshot ?? {}),
    })

    const limitationsSnapshot = inferLimitations(toolSnapshot, boundarySnapshot, input.snapshots?.limitationsSnapshot)

    const fixture = reflexivityFixtureSchema.parse({
        schemaVersion: 'reflexivity-fixture-v1',
        fixtureId: input.fixtureId ?? `fixture-${randomUUID()}`,
        collectedAt,
        context: {
            teamId: input.context?.teamId ?? identity.teamId ?? null,
            sessionId: input.context?.sessionId ?? identity.sessionId ?? null,
            runtimeType: input.context?.runtimeType ?? identity.runtimeType ?? null,
        },
        identitySnapshot: identity,
        taskSnapshot,
        environmentSnapshot,
        toolSnapshot,
        boundarySnapshot,
        limitationsSnapshot,
        artifactSnapshot: input.snapshots?.artifactSnapshot ?? {},
        collectionLog: log,
    })

    for (const [name, tool] of Object.entries(fixture.toolSnapshot.tools)) {
        if (tool.status === 'failed') {
            fixture.collectionLog.push(collectionLogEntrySchema.parse({
                step: `probe:${name}`,
                status: 'failed',
                message: tool.error ?? `${name} probe failed`,
                recordedAt: tool.probedAt ?? collectedAt,
            }))
        }
        if (tool.status === 'permission_denied') {
            fixture.collectionLog.push(collectionLogEntrySchema.parse({
                step: `probe:${name}`,
                status: 'info',
                message: tool.error ?? `${name} permission denied`,
                recordedAt: tool.probedAt ?? collectedAt,
            }))
        }
        if (tool.status === 'unavailable') {
            fixture.collectionLog.push(collectionLogEntrySchema.parse({
                step: `probe:${name}`,
                status: 'fallback',
                message: tool.error ?? `${name} unavailable`,
                recordedAt: tool.probedAt ?? collectedAt,
            }))
        }
    }

    return fixture
}
