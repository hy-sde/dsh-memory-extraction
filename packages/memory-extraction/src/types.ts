/**
 * Vocabulary for automatic long-term-memory extraction (Maka port, slice No. 2):
 * the frozen source snapshot, evidence records, proposal items, admission
 * results, and the durable cursor / receipt / pending-failure records the
 * pipeline commits through.
 *
 * The pipeline is additive to DSH's explicit `retain`/`learn`/`memory_edit`
 * surface — same `ctx.memory` store, one new trigger (compaction checkpoints).
 * Maka's 8-facet memory-item schema (kind/statementType/temporalType/scope/
 * keys) is deliberately NOT ported: DSH's bank stores plain content + context
 * + source + importance. The Maka discipline that IS load-bearing — verbatim
 * quote admission, deterministic policy rejection, canonicalization
 * re-admission, bounded evidence, deterministic operation ids — lives in
 * `evidence.ts`/`proposal.ts`/`engine.ts` unchanged.
 * @module @hy-sde-org/dsh-memory-extraction/types
 */

/** v1 triggers only `compaction`; `remember`/`extract` are reserved (Maka names, not ported as tools). */
export type MemoryExtractionTrigger = 'compaction'

export type MemoryExtractionGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'disabled' | 'ineligible' | 'unavailable' }

/**
 * Frozen extraction request. The runtime builds it from the live session at
 * trigger time and freezes exactly the facts the pipeline may read; the engine
 * never touches the live session after this point.
 */
export interface MemoryExtractionSourceSnapshot {
  readonly trigger: MemoryExtractionTrigger
  readonly sessionId: string
  /** Durable boundary: the seq of the triggering `compaction/summary` event. */
  readonly boundarySeq: number
  /** Absolute project cwd for the memory commit (session header). */
  readonly workspaceKey?: string
  /** Routed provider/model for the auxiliary call (session request header). */
  readonly provider?: string
  readonly model?: string
  /** Gate facts: subagent children are policy-denied from the automatic path. */
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
}

/**
 * One session-log entry reduced to the portable text facts the engine needs.
 * The runtime adapter projects real `SessionEvent`s into this shape, so the
 * engine stays testable without a live `Session`. Anything the adapter does
 * not carry (tool calls, thinking, attachments, provider metadata) is
 * deliberately outside the memory interpretation domain.
 */
export interface MemoryExtractionTextEvent {
  /** Session seq — the pipeline's ordinal. */
  readonly seq: number
  /** `user` / `assistant` / `other` (tool, plugin checkpoint, log marker). */
  readonly role: 'user' | 'assistant' | 'other'
  /** Producer identity: `user` (human), `model`, `plugin`, `tool`, `other`. */
  readonly author: 'user' | 'model' | 'plugin' | 'tool' | 'other'
  /** Joined text of the event's text content blocks; absent for non-text events. */
  readonly text?: string
  /** Turn identity when the adapter can derive one (DSH turn number); absent otherwise. */
  readonly turn?: number
  /** Unix epoch milliseconds. */
  readonly time: number
}

/** One seq-positioned entry in the event window. */
export interface MemoryExtractionEventEntry {
  readonly seq: number
  readonly event: MemoryExtractionTextEvent
}

/** One bounded user-authored evidence record. */
export interface MemoryExtractionEvidence {
  /** Stable ref used in proposal citations: `event:<seq>`. */
  readonly sourceRef: string
  readonly type: 'user_message'
  /** Exactly the bounded text shown to the model and used for admission. */
  readonly text: string
  readonly events: readonly MemoryExtractionTextEvent[]
}

/** The complete coverage plan for one trigger range. */
export interface MemoryCoveragePlan {
  readonly entries: readonly MemoryExtractionEventEntry[]
  readonly evidence: readonly MemoryExtractionEvidence[]
}

/* ── proposal vocabulary ─────────────────────────────────────────────────── */

/** One verbatim-cited evidence citation inside a proposal item. */
export interface MemoryEvidenceCitation {
  readonly sourceRef: string
  readonly quote: string
}

/**
 * One proposed memory item (stage 1). Maka's facet set is reduced to content
 * + citations; admission enforces bounds, verbatim quotes, and policy.
 */
export interface MemoryProposalItem {
  readonly content: string
  readonly evidence: readonly MemoryEvidenceCitation[]
}

/** Stage-1 result for an incidental (automatic) extraction. */
export type MemoryProposal =
  | { readonly status: 'complete'; readonly incidents: readonly MemoryProposalItem[] }
  | {
    readonly status: 'search_required'
    readonly search: { readonly terms: readonly string[]; readonly roles?: readonly ('user' | 'assistant')[] }
  }
  | { readonly status: 'cannot_resolve' }

/** Localized (second-pass) result: complete or cannot_resolve. */
export type LocalizedMemoryProposal =
  | { readonly status: 'complete'; readonly incidents: readonly MemoryProposalItem[] }
  | { readonly status: 'cannot_resolve' }

/** Canonicalization result: accept/rewrite or reject per candidate id. */
export type MemoryCanonicalization = {
  readonly results: readonly {
    readonly candidateId: string
    readonly status: 'accepted' | 'rejected'
    /** Rewritten durable content for `accepted` (admission re-runs against the original evidence quotes). */
    readonly content?: string
  }[]
}

/** One admitted item ready to commit. */
export interface AdmittedMemoryItem {
  readonly content: string
  readonly citedSeqs: readonly number[]
}

/* ── durable ledger vocabulary ───────────────────────────────────────────── */

/** Session-wide watermark: the highest seq already evaluated for memory. */
export interface MemoryExtractionCursor {
  readonly sessionId: string
  readonly processedSeq: number
  readonly updatedAt: number
}

/** One frozen range retained for exactly one later retry. */
export interface PendingMemoryExtractionFailure {
  readonly sessionId: string
  readonly fromSeq: number
  readonly throughSeq: number
  readonly coverageHash: string
  readonly operationId: string
  readonly attempts: number
  readonly failureClass: MemoryExtractionFailureClass
  readonly failedAt: number
}

export type MemoryExtractionFailureClass =
  | 'provider'
  | 'schema'
  | 'evidence'
  | 'localization'
  | 'admission'

export interface MemoryExtractionReceipt {
  readonly operationId: string
  readonly sessionId: string
  readonly status: 'extracted' | 'skipped' | 'discarded'
  /** Committed contents, in commit order (for the result message). */
  readonly items: readonly string[]
  readonly committedAt: number
}

/** Ports request the range hash is verified against — the idempotency key. */
export interface CommitMemoryExtractionRequest {
  readonly operationId: string
  readonly sessionId: string
  readonly expectedCursorSeq: number
  readonly nextCursorSeq: number
  readonly coverageHash: string
  /** Admitted, canonicalized contents to commit. */
  readonly items: readonly AdmittedMemoryItem[]
  readonly trigger: MemoryExtractionTrigger
}

export type SettleMemoryExtractionFailureResult =
  | { readonly status: 'retry_later'; readonly pending: PendingMemoryExtractionFailure }
  | { readonly status: 'discarded'; readonly cursor: MemoryExtractionCursor }

export interface SettleMemoryExtractionFailureRequest {
  readonly operationId: string
  readonly sessionId: string
  readonly expectedCursorSeq: number
  readonly failedThroughSeq: number
  readonly coverageHash: string
  readonly failureClass: MemoryExtractionFailureClass
  readonly trigger: MemoryExtractionTrigger
}

/** Result of one `engine.execute` run (fail-open by contract: never throws). */
export type MemoryExtractionRunResult =
  | { readonly status: 'extracted'; readonly items: readonly string[] }
  | { readonly status: 'skipped' }
  | { readonly status: 'no_range' }
  | { readonly status: 'unavailable'; readonly reason?: string }
