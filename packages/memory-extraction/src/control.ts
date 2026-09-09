/**
 * The memory-extraction control store: durable per-session cursor, idempotency
 * receipts, and the single pending-failure record, over one {@link KvUnit}
 * (`memory_extraction`). Same pattern as `dsh-graph-control`: single write
 * chain, heal-on-open, no SQL transactions (the storage contract already
 * forbids concurrent writers on one unit).
 *
 * Write ordering is load-bearing: the CURSOR is written before the receipt so
 * a crash between the two can never double-process a range (the next trigger's
 * range starts at the new cursor), and a pending failure is written before any
 * retry settles so a crash mid-retry keeps the pending row.
 * @module @hy-sde-org/dsh-memory-extraction/control
 */

import type { KvUnit } from '@deepseek-ai/dsh-storage'
import type {
  MemoryExtractionCursor,
  MemoryExtractionReceipt,
  PendingMemoryExtractionFailure,
} from './types.ts'

export const MEMORY_EXTRACTION_CONTROL_UNIT_NAME = 'memory_extraction'
export const MEMORY_EXTRACTION_CONTROL_UNIT_VERSION = 1

const UNIT_TABLES = ['cursors', 'receipts', 'failures'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class MemoryExtractionControlStore {
  /** The unit descriptor callers open with `storage.backend.<name>.kv.open(descriptor)`. */
  static readonly descriptor = {
    name: MEMORY_EXTRACTION_CONTROL_UNIT_NAME,
    version: MEMORY_EXTRACTION_CONTROL_UNIT_VERSION,
    tables: [...UNIT_TABLES],
    hasGlobal: false,
  }

  private constructor(private readonly kv: KvUnit) { }

  /** Open the store over an already-opened unit. */
  static open(kv: KvUnit): MemoryExtractionControlStore {
    return new MemoryExtractionControlStore(kv)
  }

  /** Serialize one read-modify-write over the unit (the single write chain). */
  private withChain<T>(run: () => Promise<T>): Promise<T> {
    const tail = this.tail
    const next = tail.then(run, run)
    const guarded = next.then(
      () => { if (this.tail === guarded) this.tail = Promise.resolve() },
      () => { if (this.tail === guarded) this.tail = Promise.resolve() },
    )
    this.tail = guarded
    return next
  }

  private tail: Promise<unknown> = Promise.resolve()

  /* ── cursor ──────────────────────────────────────────────────────────── */

  async readCursor(sessionId: string): Promise<MemoryExtractionCursor | undefined> {
    const { tables } = await this.kv.loadAll()
    const row = tables['cursors']?.[sessionId]
    if (!isRecord(row)) return undefined
    const processedSeq = row['processedSeq']
    const updatedAt = row['updatedAt']
    if (typeof processedSeq !== 'number' || typeof updatedAt !== 'number') return undefined
    return { sessionId, processedSeq, updatedAt }
  }

  /** Advance the watermark. Written before the receipt on every commit path. */
  writeCursor(cursor: MemoryExtractionCursor): Promise<void> {
    return this.withChain(() => this.kv.putRecord('cursors', cursor.sessionId, { ...cursor }))
  }

  /* ── receipts (idempotency) ──────────────────────────────────────────── */

  async readReceipt(operationId: string): Promise<MemoryExtractionReceipt | undefined> {
    const { tables } = await this.kv.loadAll()
    const row = tables['receipts']?.[operationId]
    if (!isRecord(row)) return undefined
    const sessionId = row['sessionId']
    const status = row['status']
    const items = row['items']
    const committedAt = row['committedAt']
    if (typeof sessionId !== 'string' || typeof status !== 'string' || typeof committedAt !== 'number') {
      return undefined
    }
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) return undefined
    return {
      operationId,
      sessionId,
      status: status as MemoryExtractionReceipt['status'],
      items: items as string[],
      committedAt,
    }
  }

  writeReceipt(receipt: MemoryExtractionReceipt): Promise<void> {
    return this.withChain(() => this.kv.putRecord('receipts', receipt.operationId, { ...receipt }))
  }

  /* ── pending failure ─────────────────────────────────────────────────── */

  async readFailure(sessionId: string): Promise<PendingMemoryExtractionFailure | undefined> {
    const { tables } = await this.kv.loadAll()
    const row = tables['failures']?.[sessionId]
    if (!isRecord(row)) return undefined
    const throughSeq = row['throughSeq']
    const coverageHash = row['coverageHash']
    const operationId = row['operationId']
    const attempts = row['attempts']
    const failureClass = row['failureClass']
    const failedAt = row['failedAt']
    if (
      typeof throughSeq !== 'number' || typeof coverageHash !== 'string'
      || typeof operationId !== 'string' || typeof attempts !== 'number'
      || typeof failureClass !== 'string' || typeof failedAt !== 'number'
    ) {
      return undefined
    }
    const fromSeq = row['fromSeq']
    return {
      sessionId,
      fromSeq: typeof fromSeq === 'number' ? fromSeq : throughSeq,
      throughSeq,
      coverageHash,
      operationId,
      attempts,
      failureClass: failureClass as PendingMemoryExtractionFailure['failureClass'],
      failedAt,
    }
  }

  writeFailure(failure: PendingMemoryExtractionFailure): Promise<void> {
    return this.withChain(() => this.kv.putRecord('failures', failure.sessionId, { ...failure }))
  }

  deleteFailure(sessionId: string): Promise<void> {
    return this.withChain(() => this.kv.deleteRecord('failures', sessionId))
  }
}
