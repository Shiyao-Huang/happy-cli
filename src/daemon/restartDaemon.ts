import type { DaemonLocallyPersistedState } from '@/persistence'

export type RestartDaemonDeps = {
  sendStopRequest: (httpPort: number) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  forceKill: (pid: number) => Promise<void> | void;
  spawnDaemon: () => Promise<void> | void;
  readDaemonState: () => Promise<DaemonLocallyPersistedState | null>;
  healthCheck: (httpPort: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

export type RestartDaemonResult = {
  oldPid: number;
  newPid: number;
  newPort: number;
  forcedKill: boolean;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitForProcessExit(args: {
  pid: number;
  timeoutMs: number;
  pollMs?: number;
  isProcessAlive: RestartDaemonDeps['isProcessAlive'];
  sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const { pid, timeoutMs, pollMs = 250, isProcessAlive, sleep } = args
  let elapsedMs = 0

  while (elapsedMs < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await sleep(pollMs)
    elapsedMs += pollMs
  }

  return !isProcessAlive(pid)
}

export async function restartDaemonFlow(
  currentState: DaemonLocallyPersistedState,
  deps: RestartDaemonDeps,
): Promise<RestartDaemonResult> {
  const sleep = deps.sleep ?? DEFAULT_SLEEP
  const oldPid = currentState.pid

  await deps.sendStopRequest(currentState.httpPort)

  let forcedKill = false
  const gracefulExit = await waitForProcessExit({
    pid: oldPid,
    timeoutMs: 10_000,
    isProcessAlive: deps.isProcessAlive,
    sleep,
  })

  if (!gracefulExit) {
    forcedKill = true
    await deps.forceKill(oldPid)

    const forcedExit = await waitForProcessExit({
      pid: oldPid,
      timeoutMs: 5_000,
      isProcessAlive: deps.isProcessAlive,
      sleep,
    })

    if (!forcedExit) {
      throw new Error(`Daemon PID ${oldPid} did not exit after SIGKILL fallback.`)
    }
  }

  await deps.spawnDaemon()

  let elapsedMs = 0
  while (elapsedMs < 30_000) {
    await sleep(1_000)
    elapsedMs += 1_000
    const nextState = await deps.readDaemonState()
    if (!nextState?.httpPort || nextState.pid === oldPid) {
      continue
    }

    const healthy = await deps.healthCheck(nextState.httpPort)
    if (healthy) {
      return {
        oldPid,
        newPid: nextState.pid,
        newPort: nextState.httpPort,
        forcedKill,
      }
    }
  }

  throw new Error(`Daemon restart timed out: new daemon was not healthy within 30s after PID ${oldPid} stopped.`)
}
