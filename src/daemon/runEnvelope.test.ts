import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildPendingRunId, finalizeRunEnvelopeFromWebhook, writeDraftRunEnvelope } from './runEnvelope'

describe('runEnvelope', () => {
  let rootDir: string | null = null

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a draft envelope using specId as the stable candidate identity', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'aha-run-envelope-'))

    const envelope = await writeDraftRunEnvelope({
      pid: 4242,
      rootDir,
      options: {
        directory: '/repo',
        sessionId: undefined,
        agent: 'claude',
        teamId: 'team-1',
        role: 'implementer',
        sessionName: 'Implementer 1',
        sessionPath: '/repo',
        specId: 'spec-123',
        executionPlane: 'mainline',
        env: {
          AHA_AGENT_PROMPT: 'Implement task ABC',
        },
      },
    })

    expect(envelope.runId).toBe(buildPendingRunId(4242))
    expect(envelope.status).toBe('draft')
    expect(envelope.candidateId).toBe('spec:spec-123')

    const path = join(rootDir, 'runs', `${envelope.runId}.json`)
    expect(existsSync(path)).toBe(true)
  })

  it('finalizes a pending envelope when the session webhook arrives', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'aha-run-envelope-'))

    await writeDraftRunEnvelope({
      pid: 9898,
      rootDir,
      options: {
        directory: '/repo',
        agent: 'codex',
        teamId: 'team-9',
        role: 'builder',
        sessionName: 'Builder',
        sessionPath: '/repo',
        executionPlane: 'mainline',
        env: {
          AHA_AGENT_PROMPT: 'Fix websocket reconnect bug',
          AHA_TEAM_MEMBER_ID: 'member-9',
        },
      },
    })

    const finalized = await finalizeRunEnvelopeFromWebhook({
      pid: 9898,
      sessionId: 'cmn-final-session',
      rootDir,
      metadata: {
        path: '/repo',
        host: 'host',
        homeDir: '/home',
        ahaHomeDir: '/aha',
        ahaLibDir: '/lib',
        ahaToolsDir: '/tools',
        hostPid: 9898,
        startedBy: 'daemon',
        role: 'builder',
        teamId: 'team-9',
        memberId: 'member-9',
        executionPlane: 'mainline',
        flavor: 'codex',
        machineId: 'machine-1',
        name: 'Builder',
      },
      spawnOptions: {
        directory: '/repo',
        agent: 'codex',
        teamId: 'team-9',
        role: 'builder',
        sessionName: 'Builder',
        sessionPath: '/repo',
        executionPlane: 'mainline',
        env: {
          AHA_AGENT_PROMPT: 'Fix websocket reconnect bug',
          AHA_TEAM_MEMBER_ID: 'member-9',
        },
      },
    })

    expect(finalized.runId).toBe('cmn-final-session')
    expect(finalized.sessionId).toBe('cmn-final-session')
    expect(finalized.status).toBe('active')
    expect(finalized.teamId).toBe('team-9')
    expect(finalized.memberId).toBe('member-9')
    expect(finalized.runtimeType).toBe('codex')
    expect(finalized.candidateId.startsWith('derived:')).toBe(true)

    const finalPath = join(rootDir, 'runs', 'cmn-final-session.json')
    const pendingPath = join(rootDir, 'runs', `${buildPendingRunId(9898)}.json`)
    expect(existsSync(finalPath)).toBe(true)
    expect(existsSync(pendingPath)).toBe(false)

    const persisted = JSON.parse(readFileSync(finalPath, 'utf-8'))
    expect(persisted.metadataSnapshot.machineId).toBe('machine-1')
  })
})
