/**
 * The gated store adapter: commits admitted items into the existing
 * `ctx.memory` project bank (the same store `retain`/`learn` write to) and
 * resolves the extraction gate. Dedupe probes the existing bank with the
 * recall search (design decision: content hash + project, via the existing
 * search) so a cross-store crash between item writes and the cursor/receipt
 * writes cannot duplicate facts on retry.
 * @module @hy-sde-org/dsh-memory-extraction/memory-adapter
 */

import type {
  MemoryContext,
  MemorySaveInput,
  MemorySaveResult,
  MemorySearchOptions,
  MemorySearchResult,
} from '@hy-sde-org/dsh-memory'
import type {
  AdmittedMemoryItem,
  MemoryExtractionGate,
  MemoryExtractionSourceSnapshot,
} from './types.ts'
import { normalizeProposedMemoryText } from './proposal.ts'

const IMPORTANCE_AUTO_EXTRACT = 0.5
const SOURCE_AUTO_EXTRACT = 'memory_extract'
const DEDUPE_PROBE_LIMIT = 5
const DEDUPE_QUERY_CHARS = 200

/** Structural view of the `ctx.memory` service the adapter needs. */
export interface MemoryCommitSurface {
  save(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult>
  search(context: MemoryContext, query: string, options?: MemorySearchOptions): Promise<MemorySearchResult>
}

/** Adapter configuration. */
export interface MemoryCommitAdapterConfig {
  /** Importance stamped on auto-extracted bank entries (default 0.5). */
  importance?: number
  /** Probe the existing bank before writing to skip exact duplicates (default true). */
  dedupe?: boolean
}

export class MemoryCommitAdapter {
  constructor(
    private readonly memory: MemoryCommitSurface,
    private readonly config: MemoryCommitAdapterConfig = {},
  ) { }

  async commitItems(input: {
    readonly sessionId: string
    readonly workspaceKey?: string
    readonly trigger: MemoryExtractionSourceSnapshot['trigger']
    readonly boundarySeq: number
    readonly items: readonly AdmittedMemoryItem[]
  }): Promise<{ readonly committed: readonly string[] }> {
    const context: MemoryContext = input.workspaceKey !== undefined
      ? { cwd: input.workspaceKey }
      : { cwd: process.cwd() }
    const importance = this.config.importance ?? IMPORTANCE_AUTO_EXTRACT
    const dedupe = this.config.dedupe ?? true
    const committed: string[] = []
    for (const item of input.items) {
      const content = normalizeProposedMemoryText(item.content)
      if (content === undefined) continue
      if (dedupe && await this.isDuplicate(context, content)) continue
      const result = await this.memory.save(context, {
        content,
        context: `automatic memory extraction from session ${input.sessionId} (compaction checkpoint through seq ${input.boundarySeq})`,
        source: SOURCE_AUTO_EXTRACT,
        importance,
        sessionId: input.sessionId,
      })
      if (result.stored > 0) committed.push(content)
    }
    return { committed }
  }

  private async isDuplicate(context: MemoryContext, content: string): Promise<boolean> {
    const query = content.slice(0, DEDUPE_QUERY_CHARS)
    const result = await this.memory.search(context, query, { limit: DEDUPE_PROBE_LIMIT })
    const expected = normalizeProposedMemoryText(content)
    if (expected === undefined) return true
    return result.items.some(item => normalizeProposedMemoryText(item.content) === expected)
  }
}

/** Resolve the extraction gate: config toggle + subagent/child exclusion. */
export function createExtractionGate(config: {
  readonly enabled?: boolean
  readonly excludeSubagents?: boolean
}): (snapshot: MemoryExtractionSourceSnapshot) => MemoryExtractionGate {
  const enabled = config.enabled ?? true
  const excludeSubagents = config.excludeSubagents ?? true
  return (snapshot) => {
    if (!enabled) return { allowed: false, reason: 'disabled' }
    if (excludeSubagents && (snapshot.origin === 'subagent' || (snapshot.delegationDepth ?? 0) > 0)) {
      return { allowed: false, reason: 'ineligible' }
    }
    return { allowed: true }
  }
}
