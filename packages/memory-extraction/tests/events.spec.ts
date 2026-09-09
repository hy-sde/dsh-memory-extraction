import { describe, expect, it } from 'vitest'
import { projectTextEvents } from '../src/events.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Ported semantics of Maka's history projection (memory-extraction-evidence):
 * only user-authored text becomes evidence; assistant text is context; tool
 * calls/results, reasoning, and plugin checkpoints carry no memory text.
 */

function userEvent(seq: number, text: string, source: 'user' | 'plugin' = 'user'): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1_000 + seq,
    data: {
      id: `m-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: source === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'compaction', form: 'notice', summary: 'x' },
    },
  } as unknown as SessionEvent
}

function assistantEvent(seq: number, visible: string, reasoning?: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `a-${seq}`,
        role: 'assistant',
        content: [
          ...reasoning !== undefined ? [{ type: 'reasoning', text: reasoning }] : [],
          { type: 'text', text: visible },
        ],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    },
  } as unknown as SessionEvent
}

function toolEvent(seq: number, name: string): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `t-${seq}`,
        role: 'user',
        content: [{ type: 'tool_result', callId: `c-${seq}`, name, result: 'tool context' }],
        source: { kind: 'tool', callId: `c-${seq}` },
      },
    },
  } as unknown as SessionEvent
}

describe('projectTextEvents', () => {
  it('projects only user/assistant text; tool, reasoning, and checkpoints stay opaque', () => {
    const projected = projectTextEvents([
      { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } } as unknown as SessionEvent,
      userEvent(1, 'Durable user preference.'),
      assistantEvent(2, 'Assistant summary text.', 'private reasoning'),
      toolEvent(3, 'Read'),
      userEvent(4, 'Checkpoint text.', 'plugin'),
      { type: 'turn/end', seq: 5, time: 1_005, data: { turn: 1, reason: 'success' } } as unknown as SessionEvent,
    ])

    const user = projected.find(entry => entry.seq === 1)
    expect(user?.role).toBe('user')
    expect(user?.author).toBe('user')
    expect(user?.text).toBe('Durable user preference.')
    expect(user?.turn).toBe(1)

    const assistant = projected.find(entry => entry.seq === 2)
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.text).toBe('Assistant summary text.')
    // Reasoning is never part of memory text.
    expect(assistant?.text).not.toContain('private reasoning')

    const tool = projected.find(entry => entry.seq === 3)
    expect(tool?.role).toBe('other')
    expect(tool?.author).toBe('tool')
    expect(tool?.text).toBeUndefined()

    const checkpoint = projected.find(entry => entry.seq === 4)
    expect(checkpoint?.role).toBe('user')
    expect(checkpoint?.author).toBe('plugin')
    expect(checkpoint?.text).toBe('Checkpoint text.')
  })

  it('omits turn markers but keeps turn identity on enclosing events', () => {
    const projected = projectTextEvents([
      { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 7 } } as unknown as SessionEvent,
      userEvent(1, 'inside turn 7'),
      { type: 'step/start', seq: 2, time: 1_002, data: { turn: 7, step: 1 } } as unknown as SessionEvent,
      assistantEvent(3, 'reply'),
      { type: 'turn/end', seq: 4, time: 1_004, data: { turn: 7, reason: 'success' } } as unknown as SessionEvent,
      userEvent(5, 'outside any turn'),
    ])
    // Turn markers are tracking-only (no text event); everything else projects.
    expect(projected.map(entry => entry.seq)).toEqual([1, 2, 3, 5])
    expect(projected[0]?.turn).toBe(7)
    expect(projected[1]?.turn).toBe(7)
    expect(projected[3]?.turn).toBeUndefined()
  })
})
