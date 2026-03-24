/**
 * @module channels/state
 * @description Persists the "current team" selection across daemon restarts.
 *
 * Stored in ~/.aha-v3/channels/state.json
 * This is a lightweight single-field file; no locking needed (only daemon writes it).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), '.aha-v3', 'channels')
const STATE_FILE = join(STATE_DIR, 'state.json')

interface PendingConfirmation {
  action: string
  params: Record<string, unknown>
  expiresAt: number
}

interface PersistedState {
  currentTeamId: string | null
  currentTeamName: string | null
}

export class ChannelState {
  currentTeamId: string | null = null
  currentTeamName: string | null = null
  pendingConfirmation: PendingConfirmation | undefined = undefined

  load(): void {
    if (!existsSync(STATE_FILE)) return
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<PersistedState>
      this.currentTeamId = raw.currentTeamId ?? null
      this.currentTeamName = raw.currentTeamName ?? null
    } catch {
      // Corrupted state; start fresh
    }
  }

  save(): void {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const data: PersistedState = {
        currentTeamId: this.currentTeamId,
        currentTeamName: this.currentTeamName,
      }
      writeFileSync(STATE_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    } catch {
      // Non-fatal
    }
  }

  switchTeam(teamId: string, teamName: string): void {
    this.currentTeamId = teamId
    this.currentTeamName = teamName
    this.save()
  }

  clearTeam(): void {
    this.currentTeamId = null
    this.currentTeamName = null
    this.save()
  }

  /** Store a pending confirmation that expires in 30 seconds. */
  setPending(action: string, params: Record<string, unknown>): void {
    this.pendingConfirmation = {
      action,
      params,
      expiresAt: Date.now() + 30_000,
    }
  }

  /** Consume and return a pending confirmation if it hasn't expired. */
  consumePending(): PendingConfirmation | undefined {
    const p = this.pendingConfirmation
    this.pendingConfirmation = undefined
    if (!p || p.expiresAt < Date.now()) return undefined
    return p
  }

  /** Status bar footer appended to command replies. */
  statusBar(): string {
    if (!this.currentTeamName) return ''
    return `\n━━━━━━━━━━━\n📍 当前: ${this.currentTeamName}`
  }
}
