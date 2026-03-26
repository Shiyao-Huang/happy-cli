import fs from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

import { configuration } from '@/configuration'
import { Metadata } from '@/api/types'
import { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers'
import { hashObject } from '@/utils/deterministicJson'

type RunEnvelopeSpawnOptions = Omit<SpawnSessionOptions, 'onPidKnown' | 'token'>

export interface RunEnvelope {
  runId: string
  sessionId: string | null
  pid: number | null
  status: 'draft' | 'active'
  teamId: string | null
  memberId: string | null
  role: string | null
  runtimeType: string | null
  executionPlane: string | null
  candidateId: string
  specId: string | null
  sessionTag: string | null
  parentSessionId: string | null
  sessionPath: string | null
  contextPrior: {
    sessionName: string | null
    promptSummary: string | null
    startedBy: string | null
  }
  metadataSnapshot?: {
    path?: string
    machineId?: string
    name?: string
    flavor?: string
  }
  spawnedAt: string
  updatedAt: string
}

function runsDir(root = configuration.ahaHomeDir): string {
  return join(root, 'runs')
}

function runPath(runId: string, root = configuration.ahaHomeDir): string {
  return join(runsDir(root), `${runId}.json`)
}

function summarizePrompt(prompt?: string): string | null {
  const trimmed = prompt?.trim()
  if (!trimmed) return null
  const compact = trimmed.replace(/\s+/g, ' ')
  return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact
}

export function deriveCandidateId(params: {
  specId?: string
  role?: string
  runtimeType?: string
  executionPlane?: string
  prompt?: string
}): string {
  if (params.specId) {
    return `spec:${params.specId}`
  }

  const digest = hashObject({
    role: params.role ?? null,
    runtimeType: params.runtimeType ?? null,
    executionPlane: params.executionPlane ?? null,
    promptSummary: summarizePrompt(params.prompt),
  })

  return `derived:${digest.slice(0, 24)}`
}

async function ensureRunsDir(root = configuration.ahaHomeDir): Promise<void> {
  await fs.mkdir(runsDir(root), { recursive: true })
}

async function readEnvelopeMaybe(runId: string, root = configuration.ahaHomeDir): Promise<RunEnvelope | null> {
  const path = runPath(runId, root)
  if (!existsSync(path)) return null

  try {
    return JSON.parse(await fs.readFile(path, 'utf-8')) as RunEnvelope
  } catch {
    return null
  }
}

export async function readRunEnvelope(runId: string, root = configuration.ahaHomeDir): Promise<RunEnvelope | null> {
  return readEnvelopeMaybe(runId, root)
}

async function writeEnvelope(envelope: RunEnvelope, root = configuration.ahaHomeDir): Promise<void> {
  await ensureRunsDir(root)
  await fs.writeFile(runPath(envelope.runId, root), JSON.stringify(envelope, null, 2), 'utf-8')
}

export function buildPendingRunId(pid: number, requestedSessionId?: string): string {
  return requestedSessionId?.trim() || `pending-pid-${pid}`
}

export async function writeDraftRunEnvelope(params: {
  pid: number
  options: RunEnvelopeSpawnOptions
  rootDir?: string
}): Promise<RunEnvelope> {
  const runId = buildPendingRunId(params.pid, params.options.sessionId)
  const now = new Date().toISOString()
  const envelope: RunEnvelope = {
    runId,
    sessionId: params.options.sessionId ?? null,
    pid: params.pid,
    status: 'draft',
    teamId: params.options.teamId ?? null,
    memberId: params.options.env?.AHA_TEAM_MEMBER_ID ?? null,
    role: params.options.role ?? null,
    runtimeType: params.options.agent ?? 'claude',
    executionPlane: params.options.executionPlane ?? null,
    candidateId: deriveCandidateId({
      specId: params.options.specId,
      role: params.options.role,
      runtimeType: params.options.agent,
      executionPlane: params.options.executionPlane,
      prompt: params.options.env?.AHA_AGENT_PROMPT,
    }),
    specId: params.options.specId ?? null,
    sessionTag: params.options.sessionTag ?? null,
    parentSessionId: params.options.parentSessionId ?? null,
    sessionPath: params.options.sessionPath ?? params.options.directory ?? null,
    contextPrior: {
      sessionName: params.options.sessionName ?? null,
      promptSummary: summarizePrompt(params.options.env?.AHA_AGENT_PROMPT),
      startedBy: 'daemon',
    },
    spawnedAt: now,
    updatedAt: now,
  }

  await writeEnvelope(envelope, params.rootDir)
  return envelope
}

export async function finalizeRunEnvelopeFromWebhook(params: {
  pid: number
  sessionId: string
  metadata: Metadata
  spawnOptions?: RunEnvelopeSpawnOptions
  rootDir?: string
}): Promise<RunEnvelope> {
  const rootDir = params.rootDir
  const pendingRunId = buildPendingRunId(params.pid, params.spawnOptions?.sessionId)
  const existing =
    await readEnvelopeMaybe(params.sessionId, rootDir)
    ?? await readEnvelopeMaybe(pendingRunId, rootDir)

  const now = new Date().toISOString()
  const teamId = params.metadata.teamId || params.metadata.roomId || params.spawnOptions?.teamId || null
  const role = params.metadata.role || params.spawnOptions?.role || null
  const runtimeType = params.metadata.flavor || params.spawnOptions?.agent || 'claude'
  const executionPlane = params.metadata.executionPlane || params.spawnOptions?.executionPlane || null
  const specId = params.spawnOptions?.specId ?? null

  const envelope: RunEnvelope = {
    runId: params.sessionId,
    sessionId: params.sessionId,
    pid: params.pid,
    status: 'active',
    teamId,
    memberId: params.metadata.memberId ?? existing?.memberId ?? null,
    role,
    runtimeType,
    executionPlane,
    candidateId: existing?.candidateId ?? deriveCandidateId({
      specId,
      role: role ?? undefined,
      runtimeType,
      executionPlane: executionPlane ?? undefined,
      prompt: params.spawnOptions?.env?.AHA_AGENT_PROMPT,
    }),
    specId,
    sessionTag: params.metadata.sessionTag ?? params.spawnOptions?.sessionTag ?? existing?.sessionTag ?? null,
    parentSessionId: params.spawnOptions?.parentSessionId ?? existing?.parentSessionId ?? null,
    sessionPath: params.metadata.path ?? params.spawnOptions?.sessionPath ?? existing?.sessionPath ?? null,
    contextPrior: existing?.contextPrior ?? {
      sessionName: params.spawnOptions?.sessionName ?? params.metadata.name ?? null,
      promptSummary: summarizePrompt(params.spawnOptions?.env?.AHA_AGENT_PROMPT),
      startedBy: params.metadata.startedBy ?? 'unknown',
    },
    metadataSnapshot: {
      path: params.metadata.path,
      machineId: params.metadata.machineId,
      name: params.metadata.name,
      flavor: params.metadata.flavor,
    },
    spawnedAt: existing?.spawnedAt ?? now,
    updatedAt: now,
  }

  await writeEnvelope(envelope, rootDir)

  if (pendingRunId !== params.sessionId) {
    const pendingPath = runPath(pendingRunId, rootDir)
    if (existsSync(pendingPath)) {
      await fs.rm(pendingPath, { force: true })
    }
  }

  return envelope
}
