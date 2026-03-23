/**
 * @module channels/formatter
 * @description Formats TeamMessageEvent into a plain-text string for WeChat.
 *
 * Format: {emoji} [{displayName}]\n{content}
 * Multi-team: adds #teamName suffix after displayName.
 */

import { TeamMessageEvent, FormattedMessage } from './types'

/** Role → emoji mapping. Mirrors the visual style used in Kanban TeamChatRoom. */
const ROLE_EMOJI: Record<string, string> = {
  orchestrator: '✨',
  master: '🎯',
  implementer: '💻',
  builder: '💻',
  coder: '💻',
  architect: '🏛️',
  framer: '🏛️',
  'qa-engineer': '🧪',
  tester: '🧪',
  reviewer: '🔍',
  observer: '👁️',
  'org-manager': '🏢',
  supervisor: '⚙️',
  'help-agent': '🆘',
  'agent-builder': '🧬',
  researcher: '🔬',
  devops: '🔧',
  system: '📋',
}

const FALLBACK_EMOJI = '🤖'

function resolveEmoji(event: TeamMessageEvent): string {
  if (event.metadata?.genomeEmoji) return String(event.metadata.genomeEmoji)
  const role = event.fromRole ?? ''
  return ROLE_EMOJI[role] ?? FALLBACK_EMOJI
}

function resolveDisplayName(event: TeamMessageEvent): string {
  return event.fromDisplayName || event.fromRole || 'agent'
}

/**
 * Format a TeamMessageEvent into a WeChat-ready plain-text message.
 * @param event - The team message to format.
 * @param multiTeam - Whether to include #teamName in the header (when >1 active team).
 */
export function formatMessage(event: TeamMessageEvent, multiTeam = false): FormattedMessage {
  const emoji = resolveEmoji(event)
  const name = resolveDisplayName(event)
  const teamTag = multiTeam ? ` #${truncate(event.teamId, 15)}` : ''
  const header = `${emoji} [${name}]${teamTag}`

  return {
    text: `${header}\n${event.content}`,
    teamId: event.teamId,
    agentRole: event.fromRole ?? 'unknown',
    originalMessageId: event.id,
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}
