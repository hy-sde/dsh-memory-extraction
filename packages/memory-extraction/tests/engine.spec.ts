import { describe, expect, it } from 'vitest'
import { MemoryExtractionEngine } from '../src/engine.ts'
import { MAX_MEMORY_EXTRACTION_MODEL_CALLS } from '../src/engine.ts'
import type { MemoryExtractionPorts, MemoryGenerateResult } from '../src/engine.ts'
import type {
  AdmittedMemoryItem,
  MemoryExtractionEventEntry,
  MemoryExtractionGate,
  MemoryExtractionSourceSnapshot,
  MemoryExtractionTextEvent,
} from '../src/types.ts'

/**
 * The engine state machine over fake ports: idempotency, empty-range advance,
 * admission, one-retry-then-discard, gate checks, and the 3-call budget.
 */

interface FakeState {
  events?: ReadonlyArray<MemoryExtractionEventEntry>
  gate?: (snapshot: MemoryExtractionSourceSnapshot) => MemoryExtractionGate
  generate?: (stage: string, prompt: string) => MemoryGenerateResult | Promise<MemoryGenerateResult>
}

interface FakeWorld {
  ports: MemoryExtractionPorts
  generateCalls: Array<{ stage: string; prompt: string }>
  committed: Array<{ sessionId: string; items: readonly AdmittedMemoryItem[] }>
  cursor: Map<string, { processedSeq: number; updatedAt: number }>
  receipts: Map<string, { status: string; items: string[] }>
  failures: Map<string, Record<string, unknown>>
  gateCalls: number
}

function textEvent(seq: number, role: 'user' | 'assistant' | 'other', author: 'user' | 'model' | 'plugin' | 'tool', text: string): MemoryExtractionTextEvent {
  return { seq, role, author, text, time: 1_000 + seq }
}

function userEntry(seq: number, text: string): MemoryExtractionEventEntry {
  return { seq, event: textEvent(seq, 'user', 'user', text) }
}

function otherEntry(seq: number): MemoryExtractionEventEntry {
  return { seq, event: textEvent(seq, 'other', 'tool', 'tool output') }
}

function snapshot(overrides: Partial<MemoryExtractionSourceSnapshot> = {}): MemoryExtractionSourceSnapshot {
  return { trigger: 'compaction', sessionId: 's1', boundarySeq: 1, ...overrides }
}

function makeWorld(initial: FakeState = {}): FakeWorld {
  const world: FakeWorld = {
    generateCalls: [],
    committed: [],
    cursor: new Map(),
    receipts: new Map(),
    failures: new Map(),
    gateCalls: 0,
    ports: undefined as unknown as MemoryExtractionPorts,
  }
  world.ports = {
    readGate: (s) => {
      world.gateCalls += 1
      if (initial.gate) return initial.gate(s)
      return { allowed: true }
    },
    readEvents: (_sessionId, fromSeq, throughSeq) =>
      (initial.events ?? []).filter(entry => entry.seq > fromSeq && entry.seq <= throughSeq),
    readCursor: (sessionId) => {
      const row = world.cursor.get(sessionId)
      return row === undefined
        ? undefined
        : { sessionId, processedSeq: row.processedSeq, updatedAt: row.updatedAt }
    },
    readReceipt: (operationId) => {
      const row = world.receipts.get(operationId)
      return row === undefined
        ? undefined
        : { operationId, sessionId: 's1', status: row.status as 'extracted' | 'skipped' | 'discarded', items: row.items, committedAt: 1 }
    },
    readFailure: (sessionId) => {
      const row = world.failures.get(sessionId)
      return row === undefined ? undefined : row as {
        sessionId: string
        fromSeq: number
        throughSeq: number
        coverageHash: string
        operationId: string
        attempts: number
        failureClass: 'provider' | 'schema'
        failedAt: number
      }
    },
    writeCursor: (cursor) => {
      world.cursor.set(cursor.sessionId, { processedSeq: cursor.processedSeq, updatedAt: cursor.updatedAt })
    },
    writeReceipt: (receipt) => {
      world.receipts.set(receipt.operationId, { status: receipt.status, items: [...receipt.items] })
    },
    writeFailure: (failure) => {
      world.failures.set(failure.sessionId, { ...failure })
    },
    deleteFailure: (sessionId) => {
      world.failures.delete(sessionId)
    },
    commitItems: ({ sessionId, items }) => {
      world.committed.push({ sessionId, items })
      return { committed: items.map(item => item.content) }
    },
    generate: ({ stage, prompt }) => {
      world.generateCalls.push({ stage, prompt })
      const impl = initial.generate
      if (impl === undefined) {
        return { ok: true, text: happyProposal(stage) }
      }
      return impl(stage, prompt)
    },
    now: () => 42,
  }
  return world
}

function happyProposal(stage: string): string {
  if (stage === 'proposal') {
    return '{"status":"complete","incidents":[{"content":"durable fact","evidence":[{"sourceRef":"event:1","quote":"durable fact"}]}]}'
  }
  if (stage === 'canonicalize') {
    return '{"results":[{"candidateId":"candidate_0","status":"accepted","content":"durable fact"}]}'
  }
  return '{"status":"cannot_resolve"}'
}

describe('MemoryExtractionEngine', () => {
  it('extracts admitted items: proposal, canonicalization, commit, cursor, receipt', async () => {
    const world = makeWorld({ events: [userEntry(1, 'durable fact')] })
    const engine = new MemoryExtractionEngine(world.ports)
    const result = await engine.execute(snapshot({ boundarySeq: 1 }))

    expect(result).toEqual({ status: 'extracted', items: ['durable fact'] })
    expect(world.generateCalls.map(call => call.stage)).toEqual(['proposal', 'canonicalize'])
    expect(world.committed).toHaveLength(1)
    expect(world.cursor.get('s1')?.processedSeq).toBe(1)
    const receipt = [...world.receipts.values()][0]
    expect(receipt?.status).toBe('extracted')
    expect(receipt?.items).toEqual(['durable fact'])
  })

  it('is idempotent by deterministic operation id (no second model run)', async () => {
    const world = makeWorld({ events: [userEntry(1, 'durable fact')] })
    const engine = new MemoryExtractionEngine(world.ports)
    const first = await engine.execute(snapshot({ boundarySeq: 1 }))
    const second = await engine.execute(snapshot({ boundarySeq: 1 }))

    expect(first.status).toBe('extracted')
    expect(second).toEqual({ status: 'extracted', items: ['durable fact'] })
    expect(world.generateCalls).toHaveLength(2)
    expect(world.committed).toHaveLength(1)
  })

  it('advances the cursor for an empty range without any model call', async () => {
    const world = makeWorld({ events: [] })
    const engine = new MemoryExtractionEngine(world.ports)
    const result = await engine.execute(snapshot({ boundarySeq: 0 }))

    expect(result).toEqual({ status: 'skipped' })
    expect(world.generateCalls).toHaveLength(0)
    expect(world.cursor.get('s1')?.processedSeq).toBe(0)
    expect([...world.receipts.values()][0]?.status).toBe('skipped')
  })

  it('skips a range whose events carry no user evidence (no model call)', async () => {
    const world = makeWorld({ events: [otherEntry(1), { seq: 2, event: textEvent(2, 'assistant', 'model', 'reply') }] })
    const engine = new MemoryExtractionEngine(world.ports)
    const result = await engine.execute(snapshot({ boundarySeq: 2 }))

    expect(result).toEqual({ status: 'skipped' })
    expect(world.generateCalls).toHaveLength(0)
    expect(world.cursor.get('s1')?.processedSeq).toBe(2)
  })

  it('fails closed on the gate: subagent snapshots are unavailable and never call the model', async () => {
    const world = makeWorld({
      events: [userEntry(1, 'durable fact')],
      gate: () => ({ allowed: false, reason: 'ineligible' }),
    })
    const engine = new MemoryExtractionEngine(world.ports)
    const result = await engine.execute(snapshot({ boundarySeq: 1, origin: 'subagent' }))

    expect(result).toEqual({ status: 'unavailable', reason: 'gate: ineligible' })
    expect(world.generateCalls).toHaveLength(0)
    expect(world.cursor.size).toBe(0)
  })

  it('skips without canonicalization when admission rejects every proposal', async () => {
    const world = makeWorld({
      events: [userEntry(1, 'durable fact')],
      generate: stage => stage === 'proposal'
        ? { ok: true, text: '{"status":"complete","incidents":[{"content":"hallucinated","evidence":[{"sourceRef":"event:1","quote":"never said"}]}]}' }
        : { ok: true, text: happyProposal(stage) },
    })
    const engine = new MemoryExtractionEngine(world.ports)
    const result = await engine.execute(snapshot({ boundarySeq: 1 }))

    expect(result).toEqual({ status: 'skipped' })
    expect(world.generateCalls.map(call => call.stage)).toEqual(['proposal'])
    expect(world.committed).toHaveLength(0)
  })

  it('records one pending failure and retries exactly once, then discards', async () => {
    const events = [userEntry(1, 'durable fact')]
    const world = makeWorld({
      events,
      generate: () => ({ ok: false, errorClass: 'provider' }),
    })
    const engine = new MemoryExtractionEngine(world.ports)

    const first = await engine.execute(snapshot({ boundarySeq: 1 }))
    expect(first.status).toBe('unavailable')
    expect(world.cursor.size).toBe(0)
    // fromSeq = first unprocessed seq (nothing processed yet → 0).
    expect(world.failures.get('s1')).toMatchObject({ attempts: 1, failureClass: 'provider', fromSeq: 0 })
    expect(world.generateCalls).toHaveLength(1)

    const second = await engine.execute(snapshot({ boundarySeq: 1 }))
    expect(second.status).toBe('unavailable')
    expect(world.failures.has('s1')).toBe(false)
    expect(world.cursor.get('s1')?.processedSeq).toBe(1)
    expect([...world.receipts.values()][0]?.status).toBe('discarded')
    expect(world.generateCalls).toHaveLength(2)

    // A later trigger for the same boundary hits the settled receipt: skipped.
    const third = await engine.execute(snapshot({ boundarySeq: 1 }))
    expect(third.status).toBe('skipped')
    expect(world.generateCalls).toHaveLength(2)
  })

  it('retries a schema failure successfully on the next trigger', async () => {
    let calls = 0
    const world = makeWorld({
      events: [userEntry(1, 'durable fact')],
      generate: (stage, _prompt) => {
        calls += 1
        if (stage === 'proposal' && calls === 1) return { ok: true, text: 'not json at all' }
        return { ok: true, text: happyProposal(stage) }
      },
    })
    const engine = new MemoryExtractionEngine(world.ports)

    const first = await engine.execute(snapshot({ boundarySeq: 1 }))
    expect(first.status).toBe('unavailable')
    expect(world.failures.get('s1')).toMatchObject({ attempts: 1, failureClass: 'schema' })

    // Same boundary: the pending row is retried with the same operation id.
    const second = await engine.execute(snapshot({ boundarySeq: 1 }))
    expect(second).toEqual({ status: 'extracted', items: ['durable fact'] })
    expect(world.failures.has('s1')).toBe(false)
    expect(world.cursor.get('s1')?.processedSeq).toBe(1)
    expect([...world.receipts.values()][0]?.status).toBe('extracted')
  })

  it('spends at most MAX_MEMORY_EXTRACTION_MODEL_CALLS model calls per range', async () => {
    const world = makeWorld({
      events: [userEntry(1, 'durable fact')],
      generate: stage => stage === 'canonicalize'
        ? { ok: true, text: 'malformed canonical' }
        : { ok: true, text: happyProposal(stage) },
    })
    const engine = new MemoryExtractionEngine(world.ports)
    const result = await engine.execute(snapshot({ boundarySeq: 1 }))

    expect(result.status).toBe('unavailable')
    expect(world.generateCalls).toHaveLength(MAX_MEMORY_EXTRACTION_MODEL_CALLS)
    expect(world.committed).toHaveLength(0)
  })

  it('drops a stale pending failure and processes only the new range', async () => {
    const world = makeWorld({ events: [userEntry(1, 'durable fact')] })
    // Torn state: cursor advanced past the failure window but the row lingers.
    world.cursor.set('s1', { processedSeq: 1, updatedAt: 1 })
    world.failures.set('s1', {
      sessionId: 's1', fromSeq: 1, throughSeq: 1, coverageHash: 'x',
      operationId: 'op', attempts: 1, failureClass: 'provider', failedAt: 1,
    })
    const engine = new MemoryExtractionEngine(world.ports)
    const result = await engine.execute(snapshot({ boundarySeq: 2 }))

    expect(result.status).toBe('skipped')
    expect(world.failures.has('s1')).toBe(false)
    expect(world.cursor.get('s1')?.processedSeq).toBe(2)
    expect(world.generateCalls).toHaveLength(0)
  })
})
