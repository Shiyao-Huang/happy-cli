/**
 * @module channels/router
 * @description Channel Router: the central hub between Aha and IM channels.
 *
 * Outbound path:
 *   teamTools.ts fire-and-forget → daemon POST /channels/notify
 *   → ChannelRouter.pushToIM(event)
 *   → format → throttle → send to registered IMChannels
 *
 * Inbound path:
 *   IMChannel.onInbound → ChannelRouter.handleInbound
 *   → command? → CommandExecutor
 *   → chat?    → daemon POST /session-command (inject into agent stdin)
 *
 * Push policy filtering:
 *   'all'       — every message
 *   'important' — task-update, help-needed, vote, handoff + priority≥high + @user
 *   'silent'    — nothing
 */

import { IMChannel, TeamMessageEvent, InboundMessage, PushPolicy } from './types'
import { formatMessage } from './formatter'
import { MessageThrottler } from './throttler'
import { ChannelState } from './state'
import { CommandExecutor } from './commandExecutor'
import { parseMessage, isConfirmation, isCancellation } from './commandParser'
import { daemonPost } from '@/daemon/controlClient'
import { loadPushPolicy } from './weixin/config'
import { logger } from '@/ui/logger'
import { ApiClient } from '@/api/api'

const IMPORTANT_TYPES = new Set(['task-update', 'help-needed', 'vote', 'handoff'])

function isImportant(event: TeamMessageEvent): boolean {
  if (IMPORTANT_TYPES.has(event.type)) return true
  const p = event.metadata?.priority
  if (p === 'high' || p === 'urgent') return true
  if (event.content.includes('@user') || event.content.includes('@human')) return true
  return false
}

export class ChannelRouter {
  private channels = new Map<string, IMChannel>()
  private throttler: MessageThrottler
  readonly state: ChannelState
  private executor: CommandExecutor
  private activeTeamIds = new Set<string>()

  constructor(api: ApiClient) {
    this.state = new ChannelState()
    this.state.load()
    this.executor = new CommandExecutor(this.state, api)
    this.throttler = new MessageThrottler((msg, channelName) => {
      const channel = this.channels.get(channelName)
      if (!channel?.connected) return
      channel.sendMessage(msg).catch(e =>
        logger.debug(`[ChannelRouter] send error on ${channelName}: ${e}`)
      )
    })
  }

  registerChannel(channel: IMChannel): void {
    this.channels.set(channel.name, channel)
    channel.onInbound(msg => this.handleInbound(msg))
    logger.debug(`[ChannelRouter] registered channel: ${channel.name}`)
  }

  unregisterChannel(name: string): void {
    this.channels.delete(name)
  }

  /** Called by daemon when a new team message arrives (via /channels/notify endpoint). */
  async pushToIM(event: TeamMessageEvent): Promise<void> {
    if (!this.channels.size) return

    const policy: PushPolicy = loadPushPolicy()
    if (policy === 'silent') return
    if (policy === 'important' && !isImportant(event)) return

    // Track active teams for multi-team header logic
    this.activeTeamIds.add(event.teamId)
    const multiTeam = this.activeTeamIds.size > 1

    // Auto-select current team on first message if none selected
    if (!this.state.currentTeamId && event.teamId) {
      this.state.switchTeam(event.teamId, event.teamId)
    }

    const formatted = formatMessage(event, multiTeam)

    for (const [name, channel] of this.channels) {
      if (!channel.connected) continue
      this.throttler.enqueue(formatted, name)
    }
  }

  // ── Inbound routing ─────────────────────────────────────────────────────────

  private async handleInbound(msg: InboundMessage): Promise<void> {
    const raw = msg.text.trim()

    // 1. Pending confirmation?
    const pending = this.state.pendingConfirmation
    if (pending && pending.expiresAt > Date.now()) {
      if (isConfirmation(raw)) {
        this.state.consumePending()
        const reply = await this.executePending(pending.action, pending.params)
        await this.replyToIM(msg, reply)
        return
      }
      if (isCancellation(raw)) {
        this.state.consumePending()
        await this.replyToIM(msg, '❌ 已取消')
        return
      }
    }

    // 2. Parse command or chat
    const parsed = parseMessage(raw)

    if (parsed.type === 'command') {
      const reply = await this.executor.execute(parsed.command, parsed.args)
      await this.replyToIM(msg, reply)
      return
    }

    // 3. Chat mode: route to agent via /session-command
    const targetTeamId = parsed.targetTeam
      ? await this.resolveTeamId(parsed.targetTeam)
      : this.state.currentTeamId

    if (!targetTeamId) {
      await this.replyToIM(msg, '❌ 未选择 Team，输入 /teams 查看，/t <编号> 选择')
      return
    }

    const targetRole = parsed.targetRole ?? 'master'
    const sessionId = await this.resolveSessionId(targetTeamId, targetRole)

    if (!sessionId) {
      await this.replyToIM(msg, `❌ 找不到 ${targetRole} — 输入 /agents 查看可用 Agent`)
      return
    }

    const prefix = '[微信消息]'
    await daemonPost('/session-command', {
      sessionId,
      command: `${prefix} ${parsed.text}`,
    })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async executePending(action: string, params: Record<string, unknown>): Promise<string> {
    if (action === 'stop-team') return this.executor.executeStop(params.teamId as string)
    if (action === 'kill-agent') return this.executor.executeKill(params.roleName as string)
    return '❓ 未知操作'
  }

  private async resolveTeamId(nameOrId: string): Promise<string | null> {
    // First try direct match, then fuzzy by name
    try {
      const { teams } = await (this.executor as any).api.listTeams()
      const match = (teams as any[]).find(t =>
        t.id === nameOrId || t.name.toLowerCase().includes(nameOrId.toLowerCase())
      )
      return match?.id ?? null
    } catch {
      return null
    }
  }

  private async resolveSessionId(teamId: string, role: string): Promise<string | null> {
    try {
      const res = await daemonPost('/list-team-sessions', { teamId })
      const sessions: any[] = res?.sessions ?? []
      const match = sessions.find(s => s.role === role || s.roleName === role)
      return match?.ahaSessionId ?? match?.sessionId ?? null
    } catch {
      return null
    }
  }

  private async replyToIM(origMsg: InboundMessage, text: string): Promise<void> {
    for (const [, channel] of this.channels) {
      if (!channel.connected) continue
      await channel.sendMessage({
        text,
        teamId: this.state.currentTeamId ?? '',
        agentRole: 'system',
        originalMessageId: '',
      }).catch(e => logger.debug(`[ChannelRouter] reply error: ${e}`))
    }
  }

  destroy(): void {
    this.throttler.destroy()
  }
}
