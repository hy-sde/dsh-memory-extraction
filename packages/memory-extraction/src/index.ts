/**
 * Automatic long-term-memory extraction at compaction checkpoints (Maka port,
 * slice No. 2): one host-plane plugin that observes every session's
 * `compaction/summary` event and runs a bounded, fail-open extraction pipeline
 * writing durable facts into the same `ctx.memory` bank `retain`/`learn` use.
 *
 * Plane split (load-bearing — do not move rows between planes):
 * - This row is HOST: it resolves host services (`memory`, `llm`,
 *   `storage.backend.<backend>`) and opens the `memory_extraction` control
 *   unit once per process. A preset row would collide on unit-open and scope
 *   the listener to one agent (and a scoped listener would miss other
 *   sessions' compactions). An unscoped host `ctx.on('session/event')` is
 *   admitted globally by the scope filter, so every session's events arrive.
 * - No tool or prompt section: DSH's explicit `retain`/`learn`/`memory_edit`
 *   surface stays the model-facing path (Maka's `memory_remember`/
 *   `memory_extract` verbs are reserved, not ported).
 * @module @hy-sde-org/dsh-memory-extraction
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MemoryExtractionRuntime, openControlUnit } from './runtime.ts'
import type { RuntimeConfig } from './runtime.ts'

export * from './types.ts'
export * from './evidence.ts'
export * from './proposal.ts'
export * from './control.ts'
export * from './engine.ts'
export * from './events.ts'
export * from './memory-adapter.ts'
export { MemoryExtractionRuntime, openControlUnit } from './runtime.ts'

/** Plugin configuration. */
export interface Config extends RuntimeConfig {
  /** Master switch; false makes the plugin inert (default true). */
  enabled?: boolean
  /** Storage backend name whose kv facet hosts the control unit (default `sqlite`). */
  backend?: string
  /** Cheap-model override; falls back to the session's routed request header. */
  provider?: string
  /** Auxiliary model id override; falls back to the session's routed request header. */
  model?: string
  /** Importance stamped on auto-extracted bank entries (default 0.5). */
  importance?: number
  /** Probe the bank before commit to skip exact duplicates (default true). */
  dedupe?: boolean
  /** Skip subagent/child sessions (default true). */
  excludeSubagents?: boolean
  /** Auxiliary call timeout in milliseconds (default 60 000). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  backend: z.string().default('sqlite'),
  provider: z.string(),
  model: z.string(),
  importance: z.number(),
  dedupe: z.boolean().default(true),
  excludeSubagents: z.boolean().default(true),
  timeoutMs: z.number().step(1).min(1),
})

export const name = 'memory-extraction'

export const inject = ['memory', 'llm']

/**
 * Mount the extraction runtime. Async boot (open the control unit) happens in
 * an effect so plugin teardown releases the unit; a missing storage backend
 * logs and leaves the plugin inert rather than failing composition.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const state = { cancelled: false }
    const disposers: Array<() => void> = []
    void (async () => {
      try {
        const { unit, store } = await openControlUnit(ctx, config.backend ?? 'sqlite')
        if (state.cancelled) {
          await unit.close()
          return
        }
        const runtime = new MemoryExtractionRuntime(ctx, config, store, ctx.memory)
        disposers.push(runtime.attach(), () => { void unit.close() })
      } catch (error: unknown) {
        ctx.logger.warn(`memory-extraction: not mounted (${String(error)}); extraction stays off`)
      }
    })()
    return () => {
      state.cancelled = true
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
}

export default { name, inject, apply }
