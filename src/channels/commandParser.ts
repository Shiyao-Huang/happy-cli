/**
 * @module channels/commandParser
 * @description Parse an inbound WeChat message into a command or chat event.
 *
 * Rules:
 *   - Leading "/" → command mode  e.g. "/teams" "/t 2" "/new fix login"
 *   - Otherwise    → chat mode
 *     - Leading "#teamName" → targetTeam
 *     - Leading "@roleName" → targetRole (after optional #teamName)
 *
 * No other syntax exists. Simple to explain to users.
 */

export interface CommandParseResult {
  type: 'command'
  command: string
  args: string[]
}

export interface ChatParseResult {
  type: 'chat'
  targetTeam?: string
  targetRole?: string
  text: string
}

export type ParseResult = CommandParseResult | ChatParseResult

export function parseMessage(raw: string): ParseResult {
  const trimmed = raw.trim()

  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).trim().split(/\s+/)
    return {
      type: 'command',
      command: parts[0].toLowerCase(),
      args: parts.slice(1),
    }
  }

  // Chat mode: extract optional #team and @role prefixes
  let text = trimmed
  let targetTeam: string | undefined
  let targetRole: string | undefined

  const teamMatch = text.match(/^#(\S+)\s*/)
  if (teamMatch) {
    targetTeam = teamMatch[1]
    text = text.slice(teamMatch[0].length).trim()
  }

  const roleMatch = text.match(/^@(\S+)\s*/)
  if (roleMatch) {
    targetRole = roleMatch[1]
    text = text.slice(roleMatch[0].length).trim()
  }

  return { type: 'chat', targetTeam, targetRole, text }
}

/** Whether the raw string looks like a simple one-word confirmation. */
export function isConfirmation(raw: string): boolean {
  return /^(确认|yes|confirm|ok)$/i.test(raw.trim())
}

/** Whether the raw string looks like a cancellation. */
export function isCancellation(raw: string): boolean {
  return /^(取消|no|cancel|算了|不|nope)$/i.test(raw.trim())
}
