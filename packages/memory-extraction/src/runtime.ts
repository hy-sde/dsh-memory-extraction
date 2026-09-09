/**
 * Host-plane runtime for automatic memory extraction: a `compaction/summary`
 * event triggers a bounded, fail-open extraction run for that session, queued
 * per session so runs never interleave. The plugin is explicitly HOST-plane:
 * one process opens the `memory_extraction` control unit once (agent rows
 * would collide), an unscoped `ctx.on('session/event')` receives every
 * session's events (scope filter admits unscoped listeners globally), and
 * `ctx.memory`/`ctx.llm` are host services.
 *
 * Estrangement rules: the run NEVER throws into the turn (every error is
 * logged and the run resolves as unavailable), never blocks compaction (the
 * listener schedules with `queueMicrotask`), and is idempotent by operation id.
 * @module @hy-sde-org/dsh-memory-extraction/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, StorageBackend } from '@deepseek-ai/dsh-storage'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: makes the optional `compaction/summary` event vocabulary available to the listener.
import type { } from '@deepseek-ai/dsh-compaction'
import type { MemoryCommitSurface } from './memory-adapter.ts'
import { MemoryCommitAdapter, createExtractionGate } from './memory-adapter.ts'
import { MemoryExtractionControlStore } from './control.ts'
import { MemoryExtractionEngine } from './engine.ts'
import type { MemoryExtractionPorts, MemoryGenerateResult } from './engine.ts'
import { projectTextEvents } from './events.ts'
import type {
  MemoryExtractionCursor,
  MemoryExtractionReceipt,
  MemoryExtractionSourceSnapshot,
  PendingMemoryExtractionFailure,
} from './types.ts'

export interface RuntimeConfig {
  /** Master switch; false makes the plugin inert (default true). */
  readonly enabled?: boolean
  /** Storage backend name whose kv facet hosts the control unit (default `sqlite`). */
  readonly backend?: string
  /** Cheap-model override; falls back to the session's routed request header. */
  readonly provider?: string
  /** Auxiliary model id override; falls back to the session's routed request header. */
  readonly model?: string
  /** Importance stamped on auto-extracted bank entries (default 0.5). */
  readonly importance?: number
  /** Probe the bank before commit to skip exact duplicates (default true). */
  readonly dedupe?: boolean
  /** Skip subagent/child sessions (default true). */
  readonly excludeSubagents?: boolean
  /** Auxiliary call timeout (default 60 000 ms). */
  readonly timeoutMs?: number
}

interface RunFacts {
  readonly snapshot: MemoryExtractionSourceSnapshot
  readonly run: () => Promise<unknown>
}

export class MemoryExtractionRuntime {
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly control: MemoryExtractionControlStore,
    private readonly memory: MemoryCommitSurface,
  ) { }

  /** Observe every session's log; returns the disposer. */
  attach(): () => void {
    return this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'compaction/summary') return
      this.enqueue(session, event)
    })
  }

  private enqueue(session: Session, event: Extract<SessionEvent, { type: 'compaction/summary' }>): void {
    const sessionId = String(session.id)
    const run = this.buildRun(session, event.seq)
    if (!run) return
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const next = previous.then(() => run.run()).catch((error: unknown) => {
      this.ctx.logger.warn(`memory-extraction: session "${sessionId}" run failed: ${String(error)}`)
    })
    this.tails.set(sessionId, next)
    // Keep the map bounded: drop the settled tail when it is still the latest.
    void next.finally(() => {
      if (this.tails.get(sessionId) === next) this.tails.delete(sessionId)
    })
  }

  private buildRun(session: Session, boundarySeq: number): RunFacts | undefined {
    const header = session.header
    const routed = session.requestHeader()?.config
    const routedProvider = routed?.provider !== undefined && routed.provider.length > 0 ? routed.provider : undefined
    const routedModel = routed?.model !== undefined && routed.model.length > 0 ? routed.model : undefined
    const provider = this.config.provider ?? routedProvider
    const model = this.config.model ?? routedModel
    const snapshot: MemoryExtractionSourceSnapshot = {
      trigger: 'compaction',
      sessionId: String(session.id),
      boundarySeq: boundarySeq,
      ...header.cwd !== undefined ? { workspaceKey: header.cwd } : {},
      ...provider !== undefined ? { provider } : {},
      ...model !== undefined ? { model } : {},
      ...header.origin !== undefined ? { origin: header.origin } : {},
      ...header.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {},
    }
    const ports = this.portsFor(session, snapshot)
    const engine = new MemoryExtractionEngine(ports)
    return { snapshot, run: () => engine.execute(snapshot) }
  }

  private portsFor(session: Session, snapshot: MemoryExtractionSourceSnapshot): MemoryExtractionPorts {
    const gate = createExtractionGate(this.config)
    const adapter = new MemoryCommitAdapter(this.memory, {
      ...this.config.importance !== undefined ? { importance: this.config.importance } : {},
      ...this.config.dedupe !== undefined ? { dedupe: this.config.dedupe } : {},
    })
    return {
      readGate: gate,
      readEvents: (_sessionId, fromSeq, throughSeq) => {
        const events = session.snapshotEvents(
          SessionLogOffset(fromSeq + 1),
          SessionLogOffset(throughSeq + 1),
        )
        return projectTextEvents(events).map(event => ({ seq: event.seq, event }))
      },
      readCursor: (sessionId: string) => this.control.readCursor(sessionId),
      readReceipt: (operationId: string) => this.control.readReceipt(operationId),
      readFailure: (sessionId: string) => this.control.readFailure(sessionId),
      writeCursor: (cursor: MemoryExtractionCursor) => this.control.writeCursor(cursor),
      writeReceipt: (receipt: MemoryExtractionReceipt) => this.control.writeReceipt(receipt),
      writeFailure: (failure: PendingMemoryExtractionFailure) => this.control.writeFailure(failure),
      deleteFailure: (sessionId: string) => this.control.deleteFailure(sessionId),
      commitItems: input => adapter.commitItems(input),
      generate: input => this.generate(input.prompt, {
        ...snapshot.provider !== undefined ? { provider: snapshot.provider } : {},
        ...snapshot.model !== undefined ? { model: snapshot.model } : {},
        sessionId: snapshot.sessionId,
      }),
      now: Date.now,
    }
  }

  private async generate(
    prompt: string,
    target: { provider?: string; model?: string; sessionId?: string },
  ): Promise<MemoryGenerateResult> {
    if (target.provider === undefined || target.model === undefined) {
      return { ok: false, errorClass: 'configuration' }
    }
    const assembler = new BlockAssembler()
    const signal = AbortSignal.timeout(this.config.timeoutMs ?? 60_000)
    const messages: Message[] = [
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-memory-extraction' },
      }),
    ]
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages,
      ...target.sessionId !== undefined ? { sessionId: SessionId(target.sessionId) } : {},
      signal,
    }
    try {
      for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
      if (classifyFinish(assembler.finish) === 'provider') {
        return { ok: false, errorClass: 'provider' }
      }
      const text = assembler.blocks()
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      if (text.trim().length === 0) return { ok: false, errorClass: 'provider' }
      return { ok: true, text }
    } catch (error: unknown) {
      if (isAbortError(error)) return { ok: false, errorClass: 'timeout' }
      return { ok: false, errorClass: 'provider' }
    }
  }
}

function classifyFinish(finish: FinishReason): 'ok' | 'provider' {
  switch (finish.kind) {
    case 'stop':
    case 'tool-calls':
      return 'ok'
    default:
      return 'provider'
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** Open the control unit for one host context (the plugin's async boot step). */
export async function openControlUnit(
  ctx: Context,
  backendName: string,
): Promise<{ unit: KvUnit; store: MemoryExtractionControlStore }> {
  const backend: StorageBackend | undefined = ctx.get(
    storageBackendServiceKey(backendName),
  ) as StorageBackend | undefined
  if (backend === undefined) {
    throw new Error(`memory-extraction: storage backend "${backendName}" is not mounted`)
  }
  if (backend.kv === undefined) {
    throw new Error(`memory-extraction: storage backend "${backendName}" has no kv facet`)
  }
  const unit = await backend.kv.open(MemoryExtractionControlStore.descriptor)
  const store = MemoryExtractionControlStore.open(unit)
  return { unit, store }
}
