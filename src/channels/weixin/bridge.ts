/**
 * @module channels/weixin/bridge
 * @description WeChat iLink Bot channel bridge.
 *
 * Implements IMChannel via HTTP long-poll (no public webhook needed).
 * Core logic ported from lib/claude-plugin-weixin/server.ts.
 *
 * Key constraints:
 *  - context_token is REQUIRED to send a message; without it we queue.
 *  - Supports 1:1 private chat only (no group chats in V1).
 *  - Messages > 2000 chars are split at semantic boundaries.
 */

import { randomBytes } from 'crypto'
import { IMChannel, WeixinCredentials, FormattedMessage, InboundMessage } from '../types'
import { loadSyncBuf, saveSyncBuf } from './config'
import { logger } from '@/ui/logger'

const MAX_CHUNK = 2000
const MAX_FAILURES = 3
const RETRY_MS = 2_000
const BACKOFF_MS = 30_000
const QUEUE_LIMIT = 10

type InboundHandler = (msg: InboundMessage) => void

export class WeixinBridge implements IMChannel {
  readonly name = 'weixin' as const

  private token = ''
  private baseUrl = ''
  private polling = false
  private failures = 0
  private syncBuf = ''

  // map senderId → latest contextToken (required to send)
  private contextTokenMap = new Map<string, string>()
  // messages queued before first contextToken arrives
  private pendingQueue: FormattedMessage[] = []
  private inboundHandler: InboundHandler | undefined

  get connected(): boolean { return this.polling }

  async connect(creds: WeixinCredentials): Promise<void> {
    this.token = creds.token
    this.baseUrl = creds.baseUrl.endsWith('/') ? creds.baseUrl : `${creds.baseUrl}/`
    this.syncBuf = loadSyncBuf()
    this.polling = true
    this.startPollLoop()
    logger.debug('[WeChat] Bridge connected, polling started')
  }

  async disconnect(): Promise<void> {
    this.polling = false
    logger.debug('[WeChat] Bridge disconnected')
  }

  async sendMessage(msg: FormattedMessage): Promise<void> {
    const contextToken = this.getLatestContextToken()
    if (!contextToken) {
      // queue until activated
      this.pendingQueue = [...this.pendingQueue, msg].slice(-QUEUE_LIMIT)
      logger.debug('[WeChat] No contextToken, message queued')
      return
    }
    const userId = this.getLatestUserId()
    if (!userId) return
    for (const chunk of chunkText(msg.text, MAX_CHUNK)) {
      await this.apiSendMessage(userId, chunk, contextToken)
    }
  }

  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler
  }

  // ── Long-poll loop ──────────────────────────────────────────────────────────

  private async startPollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const resp = await this.getUpdates(this.syncBuf)

        if (resp.ret !== undefined && resp.ret !== 0) {
          this.failures++
          logger.debug(`[WeChat] getUpdates error ret=${resp.ret} (${this.failures}/${MAX_FAILURES})`)
          await this.handleFailure()
          continue
        }

        this.failures = 0

        if (resp.get_updates_buf) {
          this.syncBuf = resp.get_updates_buf
          saveSyncBuf(this.syncBuf)
        }

        for (const raw of (resp.msgs ?? []) as any[]) {
          await this.handleInbound(raw).catch((e: unknown) =>
            logger.debug(`[WeChat] inbound handler error: ${e}`)
          )
        }
      } catch (e) {
        this.failures++
        logger.debug(`[WeChat] poll error (${this.failures}/${MAX_FAILURES}): ${e}`)
        await this.handleFailure()
      }
    }
  }

  private async handleFailure(): Promise<void> {
    if (this.failures >= MAX_FAILURES) {
      this.failures = 0
      await sleep(BACKOFF_MS)
    } else {
      await sleep(RETRY_MS)
    }
  }

  // ── Inbound message handling ────────────────────────────────────────────────

  private async handleInbound(raw: any): Promise<void> {
    if (raw.message_type !== 1) return // only user messages
    const senderId: string = raw.from_user_id
    if (!senderId) return

    if (raw.context_token) {
      this.contextTokenMap.set(senderId, raw.context_token)
      await this.flushPendingQueue(senderId, raw.context_token)
    }

    const text = extractText(raw)
    const ts = raw.create_time_ms ? raw.create_time_ms : Date.now()

    // Parse @role and #team prefixes
    let remaining = text.trim()
    let targetTeam: string | undefined
    let targetRole: string | undefined

    const teamMatch = remaining.match(/^#(\S+)\s*/)
    if (teamMatch) { targetTeam = teamMatch[1]; remaining = remaining.slice(teamMatch[0].length).trim() }

    const roleMatch = remaining.match(/^@(\S+)\s*/)
    if (roleMatch) { targetRole = roleMatch[1]; remaining = remaining.slice(roleMatch[0].length).trim() }

    this.inboundHandler?.({
      channelName: 'weixin',
      senderId,
      text: remaining || text,
      targetRole,
      targetTeam,
      contextToken: raw.context_token,
      timestamp: ts,
    })
  }

  // ── Flush queued messages after first contextToken ──────────────────────────

  private async flushPendingQueue(userId: string, contextToken: string): Promise<void> {
    if (!this.pendingQueue.length) return
    const queued = this.pendingQueue
    this.pendingQueue = []
    logger.debug(`[WeChat] flushing ${queued.length} queued messages`)
    for (const msg of queued) {
      for (const chunk of chunkText(msg.text, MAX_CHUNK)) {
        await this.apiSendMessage(userId, chunk, contextToken).catch((e: unknown) =>
          logger.debug(`[WeChat] flush send error: ${e}`)
        )
      }
    }
  }

  // ── API helpers ─────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const uint32 = randomBytes(4).readUInt32BE(0)
    const uin = Buffer.from(String(uint32), 'utf-8').toString('base64')
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.token}`,
      'X-WECHAT-UIN': uin,
    }
  }

  private async apiFetch(endpoint: string, body: object, timeoutMs = 15_000): Promise<any> {
    const url = new URL(endpoint, this.baseUrl).toString()
    const bodyStr = JSON.stringify(body)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...this.buildHeaders(), 'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')) },
        body: bodyStr,
        signal: controller.signal,
      })
      clearTimeout(timer)
      const text = await res.text()
      if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`)
      return JSON.parse(text)
    } catch (e) {
      clearTimeout(timer)
      throw e
    }
  }

  private async getUpdates(buf: string): Promise<any> {
    try {
      return await this.apiFetch('ilink/bot/getupdates', {
        get_updates_buf: buf,
        base_info: { channel_version: '0.1.0' },
      }, 35_000)
    } catch (e: any) {
      if (e?.name === 'AbortError') return { ret: 0, msgs: [], get_updates_buf: buf }
      throw e
    }
  }

  private async apiSendMessage(to: string, text: string, contextToken: string): Promise<void> {
    await this.apiFetch('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: `aha-weixin-${Date.now()}-${randomBytes(4).toString('hex')}`,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: '0.1.0' },
    })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private getLatestContextToken(): string | undefined {
    const entries = Array.from(this.contextTokenMap.values())
    return entries[entries.length - 1]
  }

  private getLatestUserId(): string | undefined {
    const entries = Array.from(this.contextTokenMap.keys())
    return entries[entries.length - 1]
  }
}

// ── Utility functions ─────────────────────────────────────────────────────────

function extractText(msg: any): string {
  const items: any[] = msg.item_list ?? []
  const parts: string[] = []
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text) parts.push(item.text_item.text)
    else if (item.type === 2) parts.push('(图片)')
    else if (item.type === 3) parts.push(item.voice_item?.text ?? '(语音)')
    else if (item.type === 4) parts.push(`(文件: ${item.file_item?.file_name ?? 'unknown'})`)
    else if (item.type === 5) parts.push('(视频)')
  }
  return parts.join('\n') || '(空消息)'
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para  = rest.lastIndexOf('\n\n', limit)
    const line  = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut   = para  > limit / 2 ? para
                : line  > limit / 2 ? line
                : space > 0         ? space
                : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
