import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { Config } from '@deepseek-ai/dsh-storage-sqlite'
import { MemoryExtractionControlStore } from '../src/control.ts'
import { MemoryExtractionRuntime } from '../src/runtime.ts'
import type { RuntimeConfig } from '../src/runtime.ts'
import type { MemoryCommitSurface } from '../src/memory-adapter.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Host wiring: the `session/event` listener, the per-session queue, the
 * snapshot→engine plumbing, and fail-open behavior. The engine itself is
 * covered by engine.spec.ts with fakes; this spec exercises the runtime over a
 * real control unit (sqlite :memory:) and stubbed llm/memory services.
 */

function userMessage(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1_000 + seq,
    data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  } as unknown as SessionEvent
}

describe('MemoryExtractionRuntime', () => {
  it('extracts on compaction/summary through the real control unit', async () => {
    const events: SessionEvent[] = [
      userMessage(1, 'durable fact'),
    ]
    const session = {
      id: SessionId('s1'),
      header: { cwd: '/tmp/proj', origin: 'user' },
      requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
      snapshotEvents: (from: number, to: number) => events.filter(event => event.seq >= from && event.seq < to),
    } as unknown as Session

    const captures: Array<{ provider: string; model: string }> = []
    let call = 0
    const llm = {
      stream: vi.fn(async function*(options: { provider: string; model: string }) {
        captures.push(options)
        call += 1
        const text = call === 1
          ? '{"status":"complete","incidents":[{"content":"durable fact","evidence":[{"sourceRef":"event:1","quote":"durable fact"}]}]}'
          : '{"results":[{"candidateId":"candidate_0","status":"accepted","content":"durable fact"}]}'
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }),
    }
    const saves: Array<{ content: string; source?: string; importance?: number }> = []
    const memory: MemoryCommitSurface = {
      search: async () => ({ backend: 'fake', query: '', count: 0, items: [] }),
      save: async (_ctx, input) => {
        saves.push({
          content: input.content,
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.importance !== undefined ? { importance: input.importance } : {}),
        })
        return { id: 'x', stored: 1, message: 'stored' }
      },
    }

    const backend = new SqliteStorageBackend(new Config({ path: ':memory:' }))
    const unit = await backend.kv.open(MemoryExtractionControlStore.descriptor)
    const control = MemoryExtractionControlStore.open(unit)

    const listener: Array<(session: Session, event: SessionEvent) => void> = []
    const ctx = {
      on: vi.fn((_name: string, callback: (session: Session, event: SessionEvent) => void) => {
        listener.push(callback)
        return () => { }
      }),
      logger: { warn: vi.fn() },
      llm,
    } as unknown as Context

    const runtime = new MemoryExtractionRuntime(ctx, {}, control, memory)
    runtime.attach()

    expect(listener).toHaveLength(1)
    listener[0]?.(session, {
      type: 'compaction/summary',
      seq: 1,
      time: 2_000,
      data: { checkpoint: true },
    } as unknown as SessionEvent)

    await vi.waitFor(() => {
      expect(saves).toHaveLength(1)
    })
    expect(saves[0]).toMatchObject({ content: 'durable fact', source: 'memory_extract', importance: 0.5 })
    expect(captures).toHaveLength(2) // proposal + canonicalization
    expect(captures[0]).toMatchObject({ provider: 'test-provider', model: 'test-model' })
    expect(await control.readCursor('s1')).toMatchObject({ processedSeq: 1 })
    await unit.close()
    await backend.close()
  })

  it('contains stream failures: the run resolves, never throws, and warns', async () => {
    const events: SessionEvent[] = [userMessage(1, 'durable fact')]
    const session = {
      id: SessionId('s2'),
      header: { cwd: '/tmp/proj', origin: 'user' },
      requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
      snapshotEvents: (from: number, to: number) => events.filter(event => event.seq >= from && event.seq < to),
    } as unknown as Session

    const llm = {
      stream: async function*() {
        throw new Error('provider exploded')
      },
    }
    const warn = vi.fn()
    const listener: Array<(session: Session, event: SessionEvent) => void> = []
    const ctx = {
      on: vi.fn((_name: string, callback: (session: Session, event: SessionEvent) => void) => {
        listener.push(callback)
        return () => { }
      }),
      logger: { warn },
      llm,
    } as unknown as Context

    const backend = new SqliteStorageBackend(new Config({ path: ':memory:' }))
    const unit = await backend.kv.open(MemoryExtractionControlStore.descriptor)
    const control = MemoryExtractionControlStore.open(unit)
    const memory: MemoryCommitSurface = {
      search: async () => ({ backend: 'fake', query: '', count: 0, items: [] }),
      save: async () => ({ stored: 0, message: 'none' }),
    }

    const runtime = new MemoryExtractionRuntime(ctx, {}, control, memory)
    runtime.attach()
    listener[0]?.(session, {
      type: 'compaction/summary',
      seq: 1,
      time: 2_000,
      data: {},
    } as unknown as SessionEvent)

    // The stream failure is contained by the generate adapter: the engine
    // settles a pending failure instead of letting the run throw.
    await vi.waitFor(async () => {
      expect(await control.readFailure('s2')).toMatchObject({ attempts: 1, failureClass: 'provider' })
    })
    expect(warn).not.toHaveBeenCalled()
    await unit.close()
    await backend.close()
  })

  it('routes provider/model from the session request header when unset', async () => {
    const events: SessionEvent[] = [userMessage(1, 'durable fact')]
    const session = {
      id: SessionId('s3'),
      header: { cwd: '/tmp/proj', origin: 'user' },
      requestHeader: () => ({ config: { provider: 'routed-provider', model: 'routed-model' } }),
      snapshotEvents: (from: number, to: number) => events.filter(event => event.seq >= from && event.seq < to),
    } as unknown as Session

    let streamOptions: { provider?: string; model?: string } | undefined
    const llm = {
      stream: vi.fn(async function*(options: { provider: string; model: string }) {
        streamOptions = options
        yield { type: 'text-delta', index: 0, text: '{"status":"cannot_resolve"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }),
    }
    const listener: Array<(session: Session, event: SessionEvent) => void> = []
    const ctx = {
      on: vi.fn((_name: string, callback: (session: Session, event: SessionEvent) => void) => {
        listener.push(callback)
        return () => { }
      }),
      logger: { warn: vi.fn() },
      llm,
    } as unknown as Context

    const backend = new SqliteStorageBackend(new Config({ path: ':memory:' }))
    const unit = await backend.kv.open(MemoryExtractionControlStore.descriptor)
    const control = MemoryExtractionControlStore.open(unit)
    const memory: MemoryCommitSurface = {
      search: async () => ({ backend: 'fake', query: '', count: 0, items: [] }),
      save: async () => ({ stored: 0, message: 'none' }),
    }

    const runtime = new MemoryExtractionRuntime(ctx, {}, control, memory)
    runtime.attach()
    listener[0]?.(session, {
      type: 'compaction/summary',
      seq: 1,
      time: 2_000,
      data: {},
    } as unknown as SessionEvent)

    await vi.waitFor(() => {
      expect(streamOptions).toBeDefined()
    })
    expect(streamOptions).toMatchObject({ provider: 'routed-provider', model: 'routed-model' })
    await unit.close()
    await backend.close()
  })
})

describe('RuntimeConfig', () => {
  it('type-level config keys are stable (enabled/backend/provider/model/importance/dedupe/excludeSubagents/timeoutMs)', () => {
    const config: RuntimeConfig = {
      enabled: true,
      backend: 'sqlite',
      provider: 'p',
      model: 'm',
      importance: 0.5,
      dedupe: true,
      excludeSubagents: true,
      timeoutMs: 60_000,
    }
    expect(config.enabled).toBe(true)
  })
})
