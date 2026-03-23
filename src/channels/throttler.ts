/**
 * @module channels/throttler
 * @description Merges rapid consecutive messages from the same agent.
 *
 * Rule: messages from the same (teamId, agentRole) within 500ms are
 * coalesced into a single send, using the first message's metadata
 * but concatenated content.
 */

import { FormattedMessage } from './types'

const WINDOW_MS = 500

type FlushFn = (msg: FormattedMessage, channelName: string) => void

interface BufferEntry {
  msgs: FormattedMessage[]
  timer: ReturnType<typeof setTimeout>
}

export class MessageThrottler {
  private buffer = new Map<string, BufferEntry>()

  constructor(private readonly flush: FlushFn) {}

  enqueue(msg: FormattedMessage, channelName: string): void {
    const key = `${channelName}:${msg.teamId}:${msg.agentRole}`
    const entry = this.buffer.get(key)

    if (entry) {
      entry.msgs.push(msg)
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => this.doFlush(key, channelName), WINDOW_MS)
    } else {
      this.buffer.set(key, {
        msgs: [msg],
        timer: setTimeout(() => this.doFlush(key, channelName), WINDOW_MS),
      })
    }
  }

  private doFlush(key: string, channelName: string): void {
    const entry = this.buffer.get(key)
    if (!entry) return
    this.buffer.delete(key)

    const merged: FormattedMessage = {
      ...entry.msgs[0],
      text: entry.msgs.map(m => m.text).join('\n\n'),
    }
    this.flush(merged, channelName)
  }

  destroy(): void {
    for (const entry of this.buffer.values()) {
      clearTimeout(entry.timer)
    }
    this.buffer.clear()
  }
}
