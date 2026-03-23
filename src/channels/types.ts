/**
 * @module channels/types
 * @description Shared type definitions for IM channel bridge.
 *
 * Architecture: Channel Bridge lives entirely inside the Daemon.
 * Agent processes fire-and-forget to /channels/notify endpoint after sendTeamMessage.
 * The Daemon routes the message to configured IM channels (WeChat, Feishu, …).
 */

// ── Credentials ──────────────────────────────────────────────────────────────

export interface WeixinCredentials {
  channel: 'weixin'
  token: string
  baseUrl: string
  userId?: string
  accountId?: string
}

/** Union of all supported channel credentials (Feishu reserved for V2). */
export type ChannelCredentials = WeixinCredentials

// ── Messages ─────────────────────────────────────────────────────────────────

/** A team message as emitted by send_team_message MCP tool. */
export interface TeamMessageEvent {
  id: string
  teamId: string
  content: string
  shortContent?: string
  type: 'chat' | 'task-update' | 'notification' | 'vote' | 'challenge'
       | 'collaboration-request' | 'help-needed' | 'handoff'
  timestamp: number
  fromSessionId?: string
  fromRole?: string
  fromDisplayName?: string
  mentions?: string[]
  metadata?: {
    priority?: 'normal' | 'high' | 'urgent'
    targetSessionId?: string
    voteDecision?: 'keep' | 'replace' | 'unsure'
    genomeEmoji?: string
    [key: string]: unknown
  }
}

/** Message after formatting, ready to be sent to an IM platform. */
export interface FormattedMessage {
  text: string
  teamId: string
  agentRole: string
  originalMessageId: string
}

/** A message received from an IM user, ready to route to an agent. */
export interface InboundMessage {
  channelName: 'weixin'
  senderId: string
  text: string
  /** Parsed from leading @roleName, e.g. "@coder-1 fix it" → "coder-1". */
  targetRole?: string
  /** Parsed from leading #teamName, e.g. "#search-team status". */
  targetTeam?: string
  /** WeChat-specific: required to reply to this user. */
  contextToken?: string
  timestamp: number
}

// ── Channel interface ─────────────────────────────────────────────────────────

export interface IMChannel {
  readonly name: string
  readonly connected: boolean
  connect(credentials: ChannelCredentials): Promise<void>
  disconnect(): Promise<void>
  sendMessage(msg: FormattedMessage): Promise<void>
  onInbound(handler: (msg: InboundMessage) => void): void
}

// ── Settings ──────────────────────────────────────────────────────────────────

export type PushPolicy = 'all' | 'important' | 'silent'

export interface ChannelSettings {
  weixin?: {
    enabled: boolean
    pushPolicy: PushPolicy
  }
}
