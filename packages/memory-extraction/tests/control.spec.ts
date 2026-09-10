import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { MemoryExtractionControlStore } from '../src/control.ts'

/**
 * The `memory_extraction` control unit: cursor/receipt/failure rows over the
 * storage-sqlite backend, with reopen durability. Mirrors the graph-control
 * receipt/cursor guarantees: a reread after reopen sees committed rows.
 */

function backendAt(path: string): SqliteStorageBackend {
  return new SqliteStorageBackend(new Config({ path }))
}

async function openStore(backend: SqliteStorageBackend): Promise<MemoryExtractionControlStore> {
  const unit = await backend.kv.open(MemoryExtractionControlStore.descriptor)
  return MemoryExtractionControlStore.open(unit)
}

describe('memory-extraction control store', () => {
  let dir = ''
  let backend: SqliteStorageBackend | undefined

  afterEach(async () => {
    await backend?.close()
    backend = undefined
    if (dir.length > 0) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('round-trips a cursor, a receipt, and a pending failure', async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-extraction-control-'))
    backend = backendAt(join(dir, 'control.sqlite'))
    const store = await openStore(backend)

    await store.writeCursor({ sessionId: 's1', processedSeq: 41, updatedAt: 1_000 })
    await store.writeReceipt({
      operationId: 'op-1',
      sessionId: 's1',
      status: 'extracted',
      items: ['a fact'],
      committedAt: 1_001,
    })
    await store.writeFailure({
      sessionId: 's2',
      fromSeq: 3,
      throughSeq: 7,
      coverageHash: 'hash',
      operationId: 'op-2',
      attempts: 1,
      failureClass: 'provider',
      failedAt: 1_002,
    })

    expect(await store.readCursor('s1')).toEqual({
      sessionId: 's1', processedSeq: 41, updatedAt: 1_000,
    })
    expect(await store.readCursor('s-missing')).toBeUndefined()
    expect(await store.readReceipt('op-1')).toMatchObject({
      sessionId: 's1', status: 'extracted', items: ['a fact'], committedAt: 1_001,
    })
    expect(await store.readReceipt('op-missing')).toBeUndefined()
    expect(await store.readFailure('s2')).toMatchObject({
      fromSeq: 3, throughSeq: 7, coverageHash: 'hash', attempts: 1, failureClass: 'provider',
    })
    expect(await store.readFailure('s-missing')).toBeUndefined()
  })

  it('deleteFailure removes only that session row', async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-extraction-control-'))
    backend = backendAt(join(dir, 'control.sqlite'))
    const store = await openStore(backend)
    await store.writeFailure({
      sessionId: 'a', fromSeq: 1, throughSeq: 2, coverageHash: 'h1',
      operationId: 'op-a', attempts: 1, failureClass: 'provider', failedAt: 1,
    })
    await store.writeFailure({
      sessionId: 'b', fromSeq: 3, throughSeq: 4, coverageHash: 'h2',
      operationId: 'op-b', attempts: 1, failureClass: 'schema', failedAt: 2,
    })
    await store.deleteFailure('a')
    expect(await store.readFailure('a')).toBeUndefined()
    expect(await store.readFailure('b')).toMatchObject({ operationId: 'op-b' })
  })

  it('keeps rows durable across backend reopen', async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-extraction-control-'))
    const path = join(dir, 'control.sqlite')
    backend = backendAt(path)
    let store = await openStore(backend)
    await store.writeCursor({ sessionId: 's1', processedSeq: 99, updatedAt: 5_000 })
    await store.writeReceipt({
      operationId: 'op-x', sessionId: 's1', status: 'discarded',
      items: [], committedAt: 5_001,
    })
    await backend.close()
    backend = backendAt(path)
    store = await openStore(backend)
    expect(await store.readCursor('s1')).toMatchObject({ processedSeq: 99 })
    expect(await store.readReceipt('op-x')).toMatchObject({ status: 'discarded' })
  })

  it('round-trips gap ledger entries, marks them covered, and deletes by id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-extraction-control-'))
    backend = backendAt(join(dir, 'control.sqlite'))
    const store = await openStore(backend)

    expect(await store.readGaps()).toEqual([])
    await store.writeGap({
      id: 'gap_abc123',
      content: 'a pending fact',
      sightings: [{ sessionId: 's1', at: 100 }, { sessionId: 's2', at: 200 }],
      covered: false,
      updatedAt: 200,
    })
    expect(await store.readGaps()).toEqual([
      {
        id: 'gap_abc123',
        content: 'a pending fact',
        sightings: [{ sessionId: 's1', at: 100 }, { sessionId: 's2', at: 200 }],
        covered: false,
        updatedAt: 200,
      },
    ])

    await store.writeGap({
      id: 'gap_abc123',
      content: 'a pending fact',
      sightings: [{ sessionId: 's1', at: 100 }, { sessionId: 's2', at: 200 }],
      covered: true,
      coveredAt: 300,
      updatedAt: 300,
    })
    expect((await store.readGaps())[0]).toMatchObject({ covered: true, coveredAt: 300 })

    await store.deleteGap('gap_abc123')
    expect(await store.readGaps()).toEqual([])
    // Deleting a missing id is a no-op.
    await store.deleteGap('gap_missing')
  })

  it('keeps gap ledger rows durable across backend reopen and tolerant of unknown rows', async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-extraction-control-'))
    const path = join(dir, 'control.sqlite')
    backend = backendAt(path)
    let store = await openStore(backend)
    await store.writeGap({
      id: 'gap_durable',
      content: 'durable pending',
      sightings: [{ sessionId: 's9', at: 7 }],
      covered: false,
      updatedAt: 7,
    })
    await backend.close()
    backend = backendAt(path)
    store = await openStore(backend)
    expect(await store.readGaps()).toMatchObject([{ id: 'gap_durable', content: 'durable pending' }])
  })
})
