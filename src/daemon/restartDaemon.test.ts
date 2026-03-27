import { describe, expect, it, vi } from 'vitest'

import { restartDaemonFlow } from './restartDaemon'

describe('restartDaemonFlow', () => {
  it('restarts successfully after graceful shutdown', async () => {
    let alive = true
    let reads = 0

    const result = await restartDaemonFlow(
      {
        pid: 100,
        httpPort: 3001,
        startTime: '',
        startedWithCliVersion: '1.0.0',
      },
      {
        sendStopRequest: async () => {
          alive = false
        },
        isProcessAlive: () => alive,
        forceKill: vi.fn(),
        spawnDaemon: vi.fn(),
        readDaemonState: async () => {
          reads += 1
          return reads >= 1
            ? { pid: 200, httpPort: 3002, startTime: '', startedWithCliVersion: '1.0.1' }
            : null
        },
        healthCheck: async () => true,
        sleep: async () => {},
      },
    )

    expect(result).toEqual({
      oldPid: 100,
      newPid: 200,
      newPort: 3002,
      forcedKill: false,
    })
  })

  it('falls back to SIGKILL when graceful shutdown times out', async () => {
    let forceKilled = false
    let aliveChecks = 0

    const result = await restartDaemonFlow(
      {
        pid: 101,
        httpPort: 3001,
        startTime: '',
        startedWithCliVersion: '1.0.0',
      },
      {
        sendStopRequest: async () => {},
        isProcessAlive: () => {
          aliveChecks += 1
          return !forceKilled && aliveChecks < 100
        },
        forceKill: async () => {
          forceKilled = true
        },
        spawnDaemon: vi.fn(),
        readDaemonState: async () => ({ pid: 201, httpPort: 3003, startTime: '', startedWithCliVersion: '1.0.1' }),
        healthCheck: async () => true,
        sleep: async () => {},
      },
    )

    expect(result.forcedKill).toBe(true)
    expect(result.newPid).toBe(201)
  })

  it('fails when the new daemon never becomes healthy', async () => {
    await expect(restartDaemonFlow(
      {
        pid: 102,
        httpPort: 3001,
        startTime: '',
        startedWithCliVersion: '1.0.0',
      },
      {
        sendStopRequest: async () => {},
        isProcessAlive: () => false,
        forceKill: vi.fn(),
        spawnDaemon: vi.fn(),
        readDaemonState: async () => ({ pid: 202, httpPort: 3004, startTime: '', startedWithCliVersion: '1.0.1' }),
        healthCheck: async () => false,
        sleep: async () => {},
      },
    )).rejects.toThrow('timed out')
  })
})
