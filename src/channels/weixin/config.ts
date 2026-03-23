/**
 * @module channels/weixin/config
 * @description Read/write WeChat iLink Bot credentials and channel settings.
 *
 * Credentials: ~/.aha-v3/channels/weixin/credentials.json  (mode 0600)
 * Channel cfg: ~/.aha-v3/channels/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { WeixinCredentials, ChannelSettings, PushPolicy } from '../types'

/** Shape of the saved credentials file (no 'channel' discriminator needed on disk). */
export type WeixinSavedCreds = Omit<WeixinCredentials, 'channel'>

const CHANNEL_DIR = join(homedir(), '.aha-v3', 'channels')
const WEIXIN_DIR  = join(CHANNEL_DIR, 'weixin')
const CREDS_FILE  = join(WEIXIN_DIR, 'credentials.json')
const CONFIG_FILE = join(CHANNEL_DIR, 'config.json')

// ── Credentials ──────────────────────────────────────────────────────────────

export function loadWeixinCredentials(): WeixinCredentials | null {
  if (!existsSync(CREDS_FILE)) return null
  try {
    const raw = JSON.parse(readFileSync(CREDS_FILE, 'utf8'))
    if (!raw.token || !raw.baseUrl) return null
    return { channel: 'weixin', ...raw } as WeixinCredentials
  } catch {
    return null
  }
}

export function saveWeixinCredentials(creds: Omit<WeixinCredentials, 'channel'>): void {
  mkdirSync(WEIXIN_DIR, { recursive: true, mode: 0o700 })
  const tmp = CREDS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
  // atomic replace
  const { renameSync } = require('fs')
  renameSync(tmp, CREDS_FILE)
}

export function deleteWeixinCredentials(): void {
  try { require('fs').rmSync(CREDS_FILE, { force: true }) } catch { /* ok */ }
}

// ── Channel config (pushPolicy etc.) ─────────────────────────────────────────

function loadConfig(): ChannelSettings {
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as ChannelSettings
  } catch {
    return {}
  }
}

function saveConfig(cfg: ChannelSettings): void {
  mkdirSync(CHANNEL_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o644 })
}

export function loadPushPolicy(): PushPolicy {
  return loadConfig().weixin?.pushPolicy ?? 'all'
}

export function savePushPolicy(policy: PushPolicy): void {
  const cfg = loadConfig()
  saveConfig({ ...cfg, weixin: { enabled: true, ...(cfg.weixin ?? {}), pushPolicy: policy } })
}

export function isWeixinEnabled(): boolean {
  return loadConfig().weixin?.enabled ?? false
}

export function setWeixinEnabled(enabled: boolean): void {
  const cfg = loadConfig()
  saveConfig({ ...cfg, weixin: { pushPolicy: 'all', ...(cfg.weixin ?? {}), enabled } })
}

// ── sync_buf (long-poll cursor) ───────────────────────────────────────────────

const SYNC_BUF_FILE = join(WEIXIN_DIR, 'sync_buf.txt')

export function loadSyncBuf(): string {
  try { return readFileSync(SYNC_BUF_FILE, 'utf8').trim() } catch { return '' }
}

export function saveSyncBuf(buf: string): void {
  try {
    mkdirSync(WEIXIN_DIR, { recursive: true })
    writeFileSync(SYNC_BUF_FILE, buf)
  } catch { /* non-fatal */ }
}
