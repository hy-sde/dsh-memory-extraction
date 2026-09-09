/**
 * Projection of DSH session events into the portable text events the
 * extraction pipeline reasons about. Deliberately lossy: only user-role text
 * (evidence) and assistant-role text (interpretation context) carry `text`;
 * tool calls/results, reasoning blocks, attachments, and runtime markers stay
 * opaque (`role: 'other'`, no text) so nothing outside the memory domain can
 * leak into prompts. Ported from Maka's `projectRuntimeConversation` /
 * history-projection semantics.
 * @module @hy-sde-org/dsh-memory-extraction/events
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MemoryExtractionTextEvent } from './types.ts'

/** Join visible text blocks only (reasoning and images are never text evidence). */
function textBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Project one session event window into portable text events. `turns` tracks
 * the open `turn/start…turn/end` so `user/message` events (which carry no turn
 * field) still get a turn identity for localization grouping.
 */
export function projectTextEvents(events: readonly SessionEvent[]): MemoryExtractionTextEvent[] {
  const projected: MemoryExtractionTextEvent[] = []
  let currentTurn: number | undefined

  for (const event of events) {
    const seq = event.seq
    if (event.type === 'turn/start') {
      currentTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      currentTurn = undefined
      continue
    }
    if (event.type === 'user/message') {
      const rawKind: unknown = event.data.source.kind
      const author = rawKind === 'user' || rawKind === 'plugin' || rawKind === 'model' || rawKind === 'tool'
        ? rawKind
        : 'other'
      const text = textBlocks(event.data.content)
      projected.push({
        seq,
        role: 'user',
        author,
        ...text.length > 0 ? { text } : {},
        ...currentTurn !== undefined ? { turn: currentTurn } : {},
        time: event.time,
      })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textBlocks(event.data.message.content)
      projected.push({
        seq,
        role: 'assistant',
        author: 'model',
        ...text.length > 0 ? { text } : {},
        ...currentTurn !== undefined ? { turn: currentTurn } : {},
        time: event.time,
      })
      continue
    }
    // Tool calls, tool results, checkpoints, compaction markers, headers, …
    // carry no memory text: opaque, no text, never evidence.
    projected.push({
      seq,
      role: 'other',
      author: event.type === 'tool/call' || event.type === 'tool/result' ? 'tool' : 'other',
      ...currentTurn !== undefined ? { turn: currentTurn } : {},
      time: event.time,
    })
  }
  return projected
}
