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
    expect(envelope.candidateIdentity).toMatchObject({
      candidateId: 'spec:spec-123',
      specId: 'spec-123',
      basis: 'spec',
    })

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
    expect(finalized.candidateIdentity.basis).toBe('derived')

    const finalPath = join(rootDir, 'runs', 'cmn-final-session.json')
    const pendingPath = join(rootDir, 'runs', `${buildPendingRunId(9898)}.json`)
    expect(existsSync(finalPath)).toBe(true)
    expect(existsSync(pendingPath)).toBe(false)

    const persisted = JSON.parse(readFileSync(finalPath, 'utf-8'))
    expect(persisted.metadataSnapshot.machineId).toBe('machine-1')
  })

  it('reads materialized .genome snapshots to resolve a stable candidate identity without explicit specId', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'aha-run-envelope-'))
    const workspaceRoot = join(rootDir, 'workspace')
    await import('fs/promises').then(async ({ mkdir, writeFile }) => {
      await mkdir(join(workspaceRoot, '.claude'), { recursive: true })
      await mkdir(join(workspaceRoot, '.genome'), { recursive: true })
      await writeFile(join(workspaceRoot, '.claude', 'settings.json'), '{}', 'utf-8')
      await writeFile(join(workspaceRoot, '.genome', 'spec.json'), JSON.stringify({
        displayName: 'Genome Analyst',
        namespace: '@official',
        version: 3,
        runtimeType: 'claude',
        provenance: {
          origin: 'forked',
          parentId: 'parent-1',
          mutationNote: 'narrowed scoring scope',
        },
      }, null, 2))
      await writeFile(join(workspaceRoot, '.genome', 'lineage.json'), JSON.stringify({
        specId: '@official/genome-analyst:3',
        namespace: '@official',
        version: 3,
        origin: 'forked',
        parentId: 'parent-1',
        mutationNote: 'narrowed scoring scope',
      }, null, 2))
    })

    const envelope = await writeDraftRunEnvelope({
      pid: 5252,
      rootDir,
      options: {
        directory: workspaceRoot,
        sessionPath: workspaceRoot,
        agent: 'claude',
        role: 'researcher',
        executionPlane: 'mainline',
        env: {
          AHA_SETTINGS_PATH: join(workspaceRoot, '.claude', 'settings.json'),
        },
      },
    })

    expect(envelope.candidateId).toBe('spec:@official/genome-analyst:3')
    expect(envelope.specId).toBe('@official/genome-analyst:3')
    expect(envelope.candidateIdentity).toMatchObject({
      candidateId: 'spec:@official/genome-analyst:3',
      specId: '@official/genome-analyst:3',
      basis: 'spec',
      fullSpec: {
        namespace: '@official',
        displayName: 'Genome Analyst',
        version: 3,
        runtimeType: 'claude',
      },
      diff: {
        origin: 'forked',
        parentId: 'parent-1',
        mutationNote: 'narrowed scoring scope',
      },
    })
  })

  it('prefers runtime-reported candidate identity over spawn-time fallback during finalize', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'aha-run-envelope-'))

    await writeDraftRunEnvelope({
      pid: 6262,
      rootDir,
      options: {
        directory: '/repo',
        agent: 'claude',
        teamId: 'team-6',
        role: 'researcher',
        sessionPath: '/repo',
        executionPlane: 'mainline',
      },
    })

    const finalized = await finalizeRunEnvelopeFromWebhook({
      pid: 6262,
      sessionId: 'cmn-runtime-identity',
      rootDir,
      metadata: {
        path: '/repo',
        host: 'host',
        homeDir: '/home',
        ahaHomeDir: '/aha',
        ahaLibDir: '/lib',
        ahaToolsDir: '/tools',
        hostPid: 6262,
        startedBy: 'daemon',
        role: 'researcher',
        teamId: 'team-6',
        executionPlane: 'mainline',
        flavor: 'claude',
        specId: '@official/researcher:7',
        candidateIdentity: {
          candidateId: 'spec:@official/researcher:7',
          specId: '@official/researcher:7',
          basis: 'spec',
        },
      } as any,
      spawnOptions: {
        directory: '/repo',
        agent: 'claude',
        teamId: 'team-6',
        role: 'researcher',
        sessionPath: '/repo',
        executionPlane: 'mainline',
      },
    })

    expect(finalized.candidateId).toBe('spec:@official/researcher:7')
    expect(finalized.specId).toBe('@official/researcher:7')
    expect(finalized.candidateIdentity.basis).toBe('spec')
  })

  it('does not read stray .genome snapshots from an untrusted workspace without materialized settings', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'aha-run-envelope-'))
    const workspaceRoot = join(rootDir, 'shared-repo')
    await import('fs/promises').then(async ({ mkdir, writeFile }) => {
      await mkdir(join(workspaceRoot, '.genome'), { recursive: true })
      await writeFile(join(workspaceRoot, '.genome', 'spec.json'), JSON.stringify({
        displayName: 'Leaked Genome',
        namespace: '@official',
        version: 9,
      }, null, 2))
      await writeFile(join(workspaceRoot, '.genome', 'lineage.json'), JSON.stringify({
        specId: '@official/leaked-genome:9',
        namespace: '@official',
        version: 9,
      }, null, 2))
    })

    const envelope = await writeDraftRunEnvelope({
      pid: 7373,
      rootDir,
      options: {
        directory: workspaceRoot,
        sessionPath: workspaceRoot,
        agent: 'claude',
        role: 'help-agent',
        executionPlane: 'bypass',
      },
    })

    expect(envelope.candidateIdentity.basis).toBe('derived')
    expect(envelope.specId).toBeNull()
    expect(envelope.candidateId.startsWith('derived:')).toBe(true)
  })
})
