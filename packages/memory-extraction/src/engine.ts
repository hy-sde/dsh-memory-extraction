/**
 * The memory-extraction engine: a bounded, fail-open pipeline over frozen
 * evidence. Ported from Maka `memory-extraction.ts` with the compaction-only
 * surface (no `remember`/`extract` tools, no per-checkpoint policy denials,
 * no range-splitting) and the same load-bearing rules:
 *
 * - evidence is user-authored text only, bounded and fail-closed on overflow;
 * - proposal → admission → canonicalization → re-admission, with verbatim
 *   quote verification and deterministic secret rejection;
 * - the per-session cursor only moves to a committed boundary; empty ranges
 *   still advance; a failed range becomes one pending record retried by the
 *   next trigger and then discarded;
 * - every run is idempotent by deterministic operation id.
 *
 * The engine is pure (ports only, no cordis, no live session) so the whole
 * state machine is unit-testable with fakes.
 * @module @hy-sde-org/dsh-memory-extraction/engine
 */

import { createHash } from 'node:crypto'
import {
  evidenceByRef,
  fitMemoryExtractionEvidence,
  planMemoryCoverage,
  projectMemoryExtractionEvidence,
  renderMemoryLocalizationContext,
  searchSameSessionMemoryHistory,
} from './evidence.ts'
import {
  admitMemoryProposalItem,
  buildFirstMemoryProposalPrompt,
  buildLocalizedMemoryProposalPrompt,
  buildMemoryCanonicalizationPrompt,
  deterministicMemoryPolicyRejection,
  MAX_GAP_PROMPT_ENTRIES,
  normalizeProposedMemoryText,
  parseLocalizedMemoryProposal,
  parseMemoryCanonicalization,
  parseMemoryProposal,
} from './proposal.ts'
import type { MemoryExtractionGapPromptEntry } from './proposal.ts'
import type {
  AdmittedMemoryItem,
  MemoryCoveragePlan,
  MemoryExtractionCursor,
  MemoryExtractionEventEntry,
  MemoryExtractionFailureClass,
  MemoryExtractionGapEntry,
  MemoryExtractionGate,
  MemoryExtractionReceipt,
  MemoryExtractionRunResult,
  MemoryExtractionSourceSnapshot,
  MemoryProposalItem,
  PendingMemoryExtractionFailure,
} from './types.ts'

export type MemoryExtractionStage = 'proposal' | 'localized' | 'canonicalize'

export type MemoryGenerateResult =
  | { readonly ok: true; readonly text: string }
  | {
    readonly ok: false
    readonly errorClass: 'aborted' | 'timeout' | 'configuration' | 'provider' | 'persistence' | 'unknown'
  }

/** The ports the engine drives. One implementation: the host runtime over real services. */
export interface MemoryExtractionPorts {
  readGate(snapshot: MemoryExtractionSourceSnapshot): MemoryExtractionGate | Promise<MemoryExtractionGate>
  /** Read the session log window `(fromSeq, throughSeq]` as portable text events. */
  readEvents(
    sessionId: string,
    fromSeq: number,
    throughSeq: number,
  ): readonly MemoryExtractionEventEntry[] | Promise<readonly MemoryExtractionEventEntry[]>
  readCursor(sessionId: string): MemoryExtractionCursor | undefined | Promise<MemoryExtractionCursor | undefined>
  readReceipt(operationId: string): MemoryExtractionReceipt | undefined | Promise<MemoryExtractionReceipt | undefined>
  readFailure(
    sessionId: string,
  ): PendingMemoryExtractionFailure | undefined | Promise<PendingMemoryExtractionFailure | undefined>
  writeCursor(cursor: MemoryExtractionCursor): void | Promise<void>
  writeReceipt(receipt: MemoryExtractionReceipt): void | Promise<void>
  writeFailure(failure: PendingMemoryExtractionFailure): void | Promise<void>
  deleteFailure(sessionId: string): void | Promise<void>
  /** Read every gap-ledger entry (open and covered); the engine applies floor/expiry math. */
  readGaps(): readonly MemoryExtractionGapEntry[] | Promise<readonly MemoryExtractionGapEntry[]>
  /** Upsert one gap-ledger entry. */
  writeGap(entry: MemoryExtractionGapEntry): void | Promise<void>
  /** Delete one gap-ledger entry (expiry purge). */
  deleteGap(id: string): void | Promise<void>
  /** Commit admitted items into the project memory store; returns what was actually stored. */
  commitItems(input: {
    readonly sessionId: string
    readonly workspaceKey?: string
    readonly trigger: MemoryExtractionSourceSnapshot['trigger']
    readonly boundarySeq: number
    readonly items: readonly AdmittedMemoryItem[]
  }): {
    readonly results: readonly { readonly content: string; readonly outcome: 'committed' | 'duplicate' | 'dropped' }[]
  } | Promise<{
    readonly results: readonly { readonly content: string; readonly outcome: 'committed' | 'duplicate' | 'dropped' }[]
  }>
  /** One bounded auxiliary model call. Implementations own the timeout signal. */
  generate(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot
    readonly prompt: string
    readonly stage: MemoryExtractionStage
  }): MemoryGenerateResult | Promise<MemoryGenerateResult>
  now?(): number
}

/**
 * Engine options (config-derived). The evidence floor is opt-in per value:
 * `minGapEvidence` 0 disables the ledger entirely (pre-E1 behavior); 1 admits
 * on the first sighting while still recording; 2+ (default) requires that many
 * distinct sessions.
 */
export interface MemoryExtractionEngineOptions {
  /** Distinct sessions a fact needs before it commits (default 2; 0 disables the floor). */
  readonly minGapEvidence?: number
  /** Gap sightings older than this expire and stop counting (default 90 days). */
  readonly gapLedgerMaxAgeMs?: number
}

/** Max auxiliary model calls per range (Maka: 3). */
export const MAX_MEMORY_EXTRACTION_MODEL_CALLS = 3
/** One later retry after a settled failure, then discard (Maka keeps more states). */
export const MAX_FAILURE_ATTEMPTS = 2
/** Distinct sessions a fact needs before committing (backpass `minGapEvidence` default). */
export const DEFAULT_MIN_GAP_EVIDENCE = 2
/** Gap sightings older than this stop counting (backpass `gapLedgerMaxAge` default). */
export const DEFAULT_GAP_LEDGER_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
/** Content-hash identity: `gap_` + 24 hex chars of the normalized content's sha256. */
export const GAP_CONTENT_HASH_HEX = 24

type CoverageResult =
  | { readonly kind: 'committed'; readonly committed: readonly string[] }
  | { readonly kind: 'pending'; readonly pending: number }
  | {
    readonly kind: 'counted_failure'
    readonly failureClass: MemoryExtractionFailureClass
  }
  | { readonly kind: 'blocked' }

interface ModelBudget {
  remaining: number
}

/** One write candidate carrying its cross-session gap association. */
interface GatedWrite {
  readonly item: AdmittedMemoryItem
  readonly gapId?: string
}

export class MemoryExtractionEngine {
  constructor(
    private readonly ports: MemoryExtractionPorts,
    private readonly options: MemoryExtractionEngineOptions = {},
  ) { }

  async execute(snapshot: MemoryExtractionSourceSnapshot): Promise<MemoryExtractionRunResult> {
    if (!validSnapshot(snapshot)) return { status: 'unavailable', reason: 'invalid snapshot' }
    const operationId = memoryExtractionOperationId(snapshot)
    const gate = await this.ports.readGate(snapshot)
    if (!gate.allowed) return { status: 'unavailable', reason: `gate: ${gate.reason}` }

    const existing = await this.ports.readReceipt(operationId)
    if (existing) {
      return existing.status === 'extracted'
        ? { status: 'extracted', items: existing.items }
        : { status: 'skipped' }
    }

    const entries = await this.ports.readEvents(snapshot.sessionId, 0, snapshot.boundarySeq)
    const cursor = await this.ports.readCursor(snapshot.sessionId)
    const expectedCursor = cursor?.processedSeq ?? -1
    if (expectedCursor >= snapshot.boundarySeq) return { status: 'no_range' }

    const pendingFailure = await this.ports.readFailure(snapshot.sessionId)
    if (pendingFailure && pendingFailure.throughSeq > snapshot.boundarySeq) {
      return { status: 'unavailable', reason: 'pending failure outside trigger boundary' }
    }
    if (pendingFailure && pendingFailure.fromSeq !== expectedCursor + 1) {
      // Stale pending (cursor advanced but the failure row was not removed).
      await this.ports.deleteFailure(snapshot.sessionId)
    } else if (pendingFailure) {
      const expectedHash = memoryCoverageHash(entries, expectedCursor, pendingFailure.throughSeq)
      if (pendingFailure.coverageHash !== expectedHash) {
        return { status: 'unavailable', reason: 'pending failure coverage changed' }
      }
      const retried = await this.processRange({
        snapshot,
        operationId: pendingFailure.operationId,
        expectedCursor,
        throughSeq: pendingFailure.throughSeq,
        expectedCoverageHash: pendingFailure.coverageHash,
        entries,
      })
      if (retried.kind === 'committed') {
        await this.ports.deleteFailure(snapshot.sessionId)
        return retried.committed.length > 0
          ? { status: 'extracted', items: retried.committed }
          : { status: 'skipped' }
      }
      if (retried.kind === 'pending') {
        await this.ports.deleteFailure(snapshot.sessionId)
        return { status: 'pending', pending: retried.pending }
      }
      if (retried.kind === 'blocked') {
        return { status: 'unavailable', reason: 'blocked' }
      }
      const settled = await this.settleCountedFailure({
        snapshot,
        operationId: pendingFailure.operationId,
        expectedCursor,
        throughSeq: pendingFailure.throughSeq,
        coverageHash: pendingFailure.coverageHash,
        failureClass: retried.failureClass,
        priorAttempts: pendingFailure.attempts,
      })
      if (settled === 'discarded') await this.ports.deleteFailure(snapshot.sessionId)
      return { status: 'unavailable', reason: `failure: ${retried.failureClass}` }
    }

    const processed = await this.processRange({
      snapshot,
      operationId,
      expectedCursor,
      throughSeq: snapshot.boundarySeq,
      entries,
    })
    if (processed.kind === 'committed') {
      return processed.committed.length > 0
        ? { status: 'extracted', items: processed.committed }
        : { status: 'skipped' }
    }
    if (processed.kind === 'pending') return { status: 'pending', pending: processed.pending }
    if (processed.kind === 'blocked') return { status: 'unavailable', reason: 'blocked' }
    const settled = await this.settleCountedFailure({
      snapshot,
      operationId,
      expectedCursor,
      throughSeq: snapshot.boundarySeq,
      coverageHash: memoryCoverageHash(entries, expectedCursor, snapshot.boundarySeq),
      failureClass: processed.failureClass,
      priorAttempts: 0,
    })
    if (settled === 'discarded') await this.ports.deleteFailure(snapshot.sessionId)
    return { status: 'unavailable', reason: `failure: ${processed.failureClass}` }
  }

  /* ── range processing ─────────────────────────────────────────────────── */

  private async processRange(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot
    readonly operationId: string
    readonly expectedCursor: number
    readonly throughSeq: number
    readonly expectedCoverageHash?: string
    readonly entries: readonly MemoryExtractionEventEntry[]
  }): Promise<CoverageResult> {
    const pendingEntries = input.entries.filter(
      entry => entry.seq > input.expectedCursor && entry.seq <= input.throughSeq,
    )
    const coverageHash = memoryCoverageHash(input.entries, input.expectedCursor, input.throughSeq)
    if (input.expectedCoverageHash !== undefined && input.expectedCoverageHash !== coverageHash) {
      return { kind: 'blocked' }
    }
    if (pendingEntries.length === 0) {
      await this.commitEmpty(input.snapshot, input.operationId, input.expectedCursor, input.throughSeq)
      return { kind: 'committed', committed: [] }
    }

    const coverage = planMemoryCoverage(pendingEntries)
    if (!coverage) return { kind: 'counted_failure', failureClass: 'evidence' }

    // A range with events but no user evidence still advances: no model call.
    if (coverage.evidence.length === 0) {
      await this.commitEmpty(input.snapshot, input.operationId, input.expectedCursor, input.throughSeq)
      return { kind: 'committed', committed: [] }
    }

    const budget: ModelBudget = { remaining: MAX_MEMORY_EXTRACTION_MODEL_CALLS }
    const now = this.now()

    const result = await this.processCoverage({
      snapshot: input.snapshot,
      operationId: input.operationId,
      expectedCursor: input.expectedCursor,
      throughSeq: input.throughSeq,
      coverage,
      entries: input.entries,
      budget,
      now,
    })
    return result
  }

  private async processCoverage(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot
    readonly operationId: string
    readonly expectedCursor: number
    readonly throughSeq: number
    readonly coverage: MemoryCoveragePlan
    readonly entries: readonly MemoryExtractionEventEntry[]
    readonly budget: ModelBudget
    readonly now: number
  }): Promise<CoverageResult> {
    const { coverage, budget } = input

    // E1: load the cross-session gap ledger once per range (open pending facts
    // for the proposal prompt + the identity index for the evidence floor).
    const gap = await this.loadGapIndex(input.now, this.gapMaxAge())

    // Stage 1: proposal over the bounded evidence.
    let proposals: readonly MemoryProposalItem[] | undefined
    let localizedEvidence: MemoryCoveragePlan['evidence'] | undefined
    let interpretationContext: string | undefined
    const stageOne = await this.callModel(
      input.snapshot,
      buildFirstMemoryProposalPrompt({
        now: input.now,
        evidence: coverage.evidence,
        ...gap.prompt.length > 0 ? { openGaps: gap.prompt } : {},
      }),
      'proposal',
      budget,
    )
    if (stageOne.kind !== 'ok') return stageOne
    const first = parseMemoryProposal(stageOne.text)
    if (!first) return { kind: 'counted_failure', failureClass: 'schema' }

    if (first.status === 'search_required') {
      if (!(await this.allowed(input.snapshot))) return { kind: 'blocked' }
      const localizedEntries = searchSameSessionMemoryHistory(
        input.entries,
        input.throughSeq,
        first.search,
        input.expectedCursor,
      )
      if (localizedEntries.length === 0) return { kind: 'counted_failure', failureClass: 'localization' }
      interpretationContext = renderMemoryLocalizationContext(localizedEntries)
      if (!interpretationContext) return { kind: 'counted_failure', failureClass: 'localization' }
      const projected = projectMemoryExtractionEvidence(localizedEntries.map(entry => entry.event))
      const fitted = fitMemoryExtractionEvidence(projected)
      if (!fitted) return { kind: 'counted_failure', failureClass: 'evidence' }
      localizedEvidence = fitted
      if (budget.remaining <= 0) return { kind: 'counted_failure', failureClass: 'localization' }
      const localizedCall = await this.callModel(
        input.snapshot,
        buildLocalizedMemoryProposalPrompt({
          now: input.now,
          evidence: fitted,
          interpretationContext,
          ...gap.prompt.length > 0 ? { openGaps: gap.prompt } : {},
        }),
        'localized',
        budget,
      )
      if (localizedCall.kind !== 'ok') return localizedCall
      const localized = parseLocalizedMemoryProposal(localizedCall.text)
      if (!localized) return { kind: 'counted_failure', failureClass: 'schema' }
      if (localized.status === 'cannot_resolve') {
        return { kind: 'counted_failure', failureClass: 'localization' }
      }
      proposals = localized.incidents
    } else if (first.status === 'cannot_resolve') {
      return { kind: 'counted_failure', failureClass: 'localization' }
    } else {
      proposals = first.incidents
    }

    // Admission (incidental): skip policy-rejected or unverifiable items.
    const evidenceMap = evidenceByRef(localizedEvidence ?? coverage.evidence)
    const candidates: Array<{
      readonly candidateId: string
      readonly item: MemoryProposalItem
      readonly admitted: AdmittedMemoryItem
      readonly gapId?: string
    }> = []
    for (const proposal of proposals) {
      if (deterministicMemoryPolicyRejection(proposal)) continue
      const admitted = admitMemoryProposalItem(proposal, evidenceMap)
      if (admitted === undefined) continue
      candidates.push({
        candidateId: `candidate_${candidates.length}`,
        item: proposal,
        admitted,
        ...proposal.gapId !== undefined ? { gapId: proposal.gapId } : {},
      })
    }
    if (candidates.length === 0) {
      await this.commitEmpty(input.snapshot, input.operationId, input.expectedCursor, input.throughSeq)
      return { kind: 'committed', committed: [] }
    }

    // Stage 2: canonicalization, then re-admission against the same evidence.
    const writes: GatedWrite[] = []
    const canonicalPrompt = buildMemoryCanonicalizationPrompt({
      now: input.now,
      candidates: candidates.map(candidate => ({
        candidateId: candidate.candidateId,
        evidence: candidate.item.evidence
          .map(citation => ({
            sourceRef: citation.sourceRef,
            quote: citation.quote,
            observedAt: Math.max(0, ...candidate.admitted.citedSeqs),
          })),
      })),
    })
    let byId: Map<string, { readonly status: 'accepted' | 'rejected'; readonly content?: string }> | undefined
    let canonicalFailureClass: MemoryExtractionFailureClass = 'schema'
    while (byId === undefined && budget.remaining > 0) {
      const canonicalCall = await this.callModel(
        input.snapshot,
        canonicalPrompt,
        'canonicalize',
        budget,
      )
      if (canonicalCall.kind === 'blocked') return canonicalCall
      if (canonicalCall.kind !== 'ok') {
        canonicalFailureClass = 'provider'
        continue
      }
      const parsed = parseMemoryCanonicalization(canonicalCall.text)
      if (parsed === undefined || parsed.results.length !== candidates.length) {
        canonicalFailureClass = 'schema'
        continue
      }
      const indexed = new Map(parsed.results.map(result => [result.candidateId, result]))
      if (
        indexed.size !== candidates.length
        || candidates.some(candidate => !indexed.has(candidate.candidateId))
      ) {
        canonicalFailureClass = 'schema'
        continue
      }
      const entries: Array<[string, { readonly status: 'accepted' | 'rejected'; readonly content?: string }]> = []
      for (const [id, result] of indexed) {
        entries.push([
          id,
          {
            status: result.status,
            ...result.content !== undefined ? { content: result.content } : {},
          },
        ])
      }
      byId = new Map(entries)
    }
    if (byId === undefined) {
      return budget.remaining <= 0 && canonicalFailureClass === 'provider'
        ? { kind: 'counted_failure', failureClass: 'provider' }
        : { kind: 'counted_failure', failureClass: canonicalFailureClass }
    }
    for (const candidate of candidates) {
      const result = byId.get(candidate.candidateId)
      if (result === undefined || result.status === 'rejected') continue
      const content = result.content
      if (content === undefined) continue
      const canonicalProposal: MemoryProposalItem = {
        content,
        evidence: candidate.item.evidence,
      }
      if (deterministicMemoryPolicyRejection(canonicalProposal)) continue
      const admitted = admitMemoryProposalItem(canonicalProposal, evidenceMap)
      if (admitted === undefined) continue
      writes.push({
        item: admitted,
        ...candidate.gapId !== undefined ? { gapId: candidate.gapId } : {},
      })
    }

    if (writes.length === 0) {
      await this.commitEmpty(input.snapshot, input.operationId, input.expectedCursor, input.throughSeq)
      return { kind: 'committed', committed: [] }
    }
    if (!(await this.allowed(input.snapshot))) return { kind: 'blocked' }

    // E1 evidence floor: only writes corroborated by enough distinct sessions
    // commit; the rest become gap sightings awaiting another session.
    const gated = await this.gateWrites({
      sessionId: input.snapshot.sessionId,
      now: input.now,
      minGapEvidence: this.minGapEvidence(),
      maxAgeMs: this.gapMaxAge(),
      index: gap.entries,
      writes,
    })
    // Persist uncorroborated sightings first: they are the ledger and must
    // survive a crash before the cursor/receipt write chain below.
    for (const entry of gated.dirty.values()) {
      if (!entry.covered) await this.ports.writeGap(entry)
    }
    if (gated.eligible.length === 0) {
      await this.ports.writeCursor({
        sessionId: input.snapshot.sessionId,
        processedSeq: input.throughSeq,
        updatedAt: this.now(),
      })
      await this.ports.writeReceipt({
        operationId: input.operationId,
        sessionId: input.snapshot.sessionId,
        status: 'pending',
        items: [],
        committedAt: this.now(),
      })
      // Purge only entries that stayed expired — a revived one was just written above.
      for (const id of gap.expired.filter(id => !gated.dirty.has(id))) await this.ports.deleteGap(id)
      return { kind: 'pending', pending: gated.deferred }
    }

    // Commit order: items first (dedupe is the cross-store idempotency
    // backstop), then cursor, then receipt. Gap-covered marks follow — a crash
    // between them only leaves a stale open entry, which the bank dedupe heals
    // on the next corroboration.
    const committed = await this.ports.commitItems({
      sessionId: input.snapshot.sessionId,
      ...input.snapshot.workspaceKey !== undefined
        ? { workspaceKey: input.snapshot.workspaceKey }
        : {},
      trigger: input.snapshot.trigger,
      boundarySeq: input.throughSeq,
      items: gated.eligible.map(write => write.item),
    })
    const committedContents: string[] = []
    for (const result of committed.results) {
      if (result.outcome !== 'committed') continue
      committedContents.push(result.content)
    }
    for (const result of committed.results) {
      if (result.outcome === 'dropped') continue
      const id = gated.idsByContent.get(result.content)
      if (id === undefined) continue
      await this.ports.writeGap(
        this.coveredGapEntry(id, result.content, gated.dirty.get(id) ?? gap.entries.get(id), input.snapshot.sessionId, input.now),
      )
    }
    await this.ports.writeCursor({
      sessionId: input.snapshot.sessionId,
      processedSeq: input.throughSeq,
      updatedAt: this.now(),
    })
    await this.ports.writeReceipt({
      operationId: input.operationId,
      sessionId: input.snapshot.sessionId,
      status: 'extracted',
      items: [...committedContents],
      committedAt: this.now(),
    })
    for (const id of gap.expired.filter(id => !gated.dirty.has(id))) await this.ports.deleteGap(id)
    return { kind: 'committed', committed: committedContents }
  }

  private async commitEmpty(
    snapshot: MemoryExtractionSourceSnapshot,
    operationId: string,
    expectedCursor: number,
    throughSeq: number,
  ): Promise<void> {
    await this.ports.writeCursor({
      sessionId: snapshot.sessionId,
      processedSeq: Math.max(expectedCursor, throughSeq),
      updatedAt: this.now(),
    })
    await this.ports.writeReceipt({
      operationId,
      sessionId: snapshot.sessionId,
      status: 'skipped',
      items: [],
      committedAt: this.now(),
    })
  }

  private async settleCountedFailure(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot
    readonly operationId: string
    readonly expectedCursor: number
    readonly throughSeq: number
    readonly coverageHash: string
    readonly failureClass: MemoryExtractionFailureClass
    readonly priorAttempts: number
  }): Promise<'retry_later' | 'discarded'> {
    const attempts = input.priorAttempts + 1
    if (attempts >= MAX_FAILURE_ATTEMPTS) {
      // Discard: advance the cursor and record the settlement. The range is
      // intentionally dropped after one retry (never a third identical run).
      await this.ports.writeCursor({
        sessionId: input.snapshot.sessionId,
        processedSeq: input.throughSeq,
        updatedAt: this.now(),
      })
      await this.ports.writeReceipt({
        operationId: input.operationId,
        sessionId: input.snapshot.sessionId,
        status: 'discarded',
        items: [],
        committedAt: this.now(),
      })
      return 'discarded'
    }
    await this.ports.writeFailure({
      sessionId: input.snapshot.sessionId,
      fromSeq: input.expectedCursor + 1,
      throughSeq: input.throughSeq,
      coverageHash: input.coverageHash,
      operationId: input.operationId,
      attempts,
      failureClass: input.failureClass,
      failedAt: this.now(),
    })
    return 'retry_later'
  }

  /* ── cross-session evidence floor (E1) ─────────────────────────────────── */

  private minGapEvidence(): number {
    return this.options.minGapEvidence ?? DEFAULT_MIN_GAP_EVIDENCE
  }

  private gapMaxAge(): number {
    return this.options.gapLedgerMaxAgeMs ?? DEFAULT_GAP_LEDGER_MAX_AGE_MS
  }

  /**
   * Load the whole gap ledger once per range: the identity index (for the
   * floor gate) plus the open, uncorroborated, non-expired entries for the
   * proposal prompt (most recently sighted first, capped). Disabled floor →
   * empty index (no reads at all).
   */
  private async loadGapIndex(now: number, maxAgeMs: number): Promise<{
    readonly entries: ReadonlyMap<string, MemoryExtractionGapEntry>
    readonly prompt: readonly MemoryExtractionGapPromptEntry[]
    readonly expired: readonly string[]
  }> {
    if (this.minGapEvidence() <= 0) return { entries: new Map(), prompt: [], expired: [] }
    const all = await this.ports.readGaps()
    const entries = new Map<string, MemoryExtractionGapEntry>()
    const open: Array<{ readonly entry: MemoryExtractionGapEntry; readonly freshCount: number }> = []
    const expired: string[] = []
    for (const entry of all) {
      entries.set(entry.id, entry)
      if (entry.covered) continue
      const fresh = entry.sightings.filter(sighting => now - sighting.at <= maxAgeMs)
      if (fresh.length === 0) {
        expired.push(entry.id)
        continue
      }
      open.push({ entry, freshCount: distinctSessionIds(fresh) })
    }
    open.sort((left, right) => right.entry.updatedAt - left.entry.updatedAt)
    const prompt = open
      .slice(0, MAX_GAP_PROMPT_ENTRIES)
      .map(item => ({ id: item.entry.id, content: item.entry.content, sessions: item.freshCount }))
    return { entries, prompt, expired }
  }

  /**
   * Apply the evidence floor to the final writes: a write commits only when
   * `minGapEvidence` DISTINCT sessions (fresh sightings plus this one, counted
   * once per session) have proposed the same gap identity; otherwise it is
   * recorded as a new sighting and deferred. `minGapEvidence <= 0` is the
   * pre-E1 path: everything commits, nothing is tracked.
   */
  private async gateWrites(input: {
    readonly sessionId: string
    readonly now: number
    readonly minGapEvidence: number
    readonly maxAgeMs: number
    readonly index: ReadonlyMap<string, MemoryExtractionGapEntry>
    readonly writes: readonly GatedWrite[]
  }): Promise<{
    readonly eligible: readonly GatedWrite[]
    readonly deferred: number
    readonly dirty: ReadonlyMap<string, MemoryExtractionGapEntry>
    readonly idsByContent: ReadonlyMap<string, string>
  }> {
    if (input.minGapEvidence <= 0) {
      return { eligible: [...input.writes], deferred: 0, dirty: new Map(), idsByContent: new Map() }
    }
    const eligible: GatedWrite[] = []
    const dirty = new Map<string, MemoryExtractionGapEntry>()
    const idsByContent = new Map<string, string>()
    let deferred = 0
    for (const write of input.writes) {
      const id = write.gapId ?? memoryGapIdForContent(write.item.content)
      if (id === undefined) {
        eligible.push(write)
        continue
      }
      idsByContent.set(write.item.content, id)
      const existing = input.index.get(id)
      if (existing?.covered === true) {
        // Already settled (committed or bank-covered): the commit/dedupe path
        // is the right one and the entry stays retired.
        eligible.push(write)
        continue
      }
      const fresh = existing?.sightings.filter(sighting => input.now - sighting.at <= input.maxAgeMs) ?? []
      const seenHere = fresh.some(sighting => sighting.sessionId === input.sessionId)
      const count = distinctSessionIds(fresh) + (seenHere ? 0 : 1)
      if (count < input.minGapEvidence) {
        deferred += 1
        dirty.set(id, {
          id,
          content: write.item.content,
          sightings: seenHere ? fresh : [...fresh, { sessionId: input.sessionId, at: input.now }],
          covered: false,
          updatedAt: input.now,
        })
        continue
      }
      eligible.push(write)
      if (existing !== undefined) {
        dirty.set(id, {
          ...existing,
          content: write.item.content,
          sightings: seenHere
            ? existing.sightings
            : [...existing.sightings, { sessionId: input.sessionId, at: input.now }],
          covered: true,
          coveredAt: input.now,
          updatedAt: input.now,
        })
      } else {
        // First sighting already satisfies the floor (minGapEvidence 1): record as covered.
        dirty.set(id, {
          id,
          content: write.item.content,
          sightings: [{ sessionId: input.sessionId, at: input.now }],
          covered: true,
          coveredAt: input.now,
          updatedAt: input.now,
        })
      }
    }
    return { eligible, deferred, dirty, idsByContent }
  }

  /** Mark one gap entry covered (committed or found already in the bank). */
  private coveredGapEntry(
    id: string,
    content: string,
    existing: MemoryExtractionGapEntry | undefined,
    sessionId: string,
    now: number,
  ): MemoryExtractionGapEntry {
    const sightings = existing?.sightings ?? []
    const seenHere = sightings.some(sighting => sighting.sessionId === sessionId)
    return {
      id,
      content,
      sightings: seenHere ? sightings : [...sightings, { sessionId, at: now }],
      covered: true,
      coveredAt: now,
      updatedAt: now,
    }
  }

  private async callModel(
    snapshot: MemoryExtractionSourceSnapshot,
    prompt: string,
    stage: MemoryExtractionStage,
    budget: ModelBudget,
  ): Promise<
    | { readonly kind: 'ok'; readonly text: string }
    | { readonly kind: 'counted_failure'; readonly failureClass: MemoryExtractionFailureClass }
    | { readonly kind: 'blocked' }
  > {
    if (budget.remaining <= 0) return { kind: 'counted_failure', failureClass: 'provider' }
    if (!(await this.allowed(snapshot))) return { kind: 'blocked' }
    budget.remaining -= 1
    const result = await this.ports.generate({ snapshot, prompt, stage })
    if (result.ok) return { kind: 'ok', text: result.text }
    if (!(await this.allowed(snapshot))) return { kind: 'blocked' }
    return result.errorClass === 'provider' || result.errorClass === 'timeout'
      ? { kind: 'counted_failure', failureClass: 'provider' }
      : { kind: 'blocked' }
  }

  private async allowed(snapshot: MemoryExtractionSourceSnapshot): Promise<boolean> {
    return (await this.ports.readGate(snapshot)).allowed
  }

  private now(): number {
    if (this.ports.now === undefined) return Date.now()
    return this.ports.now()
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

export function memoryExtractionOperationId(snapshot: MemoryExtractionSourceSnapshot): string {
  return `memory_${createHash('sha256')
    .update(JSON.stringify({
      sessionId: snapshot.sessionId,
      trigger: snapshot.trigger,
      boundarySeq: snapshot.boundarySeq,
    }))
    .digest('hex')}`
}

export function memoryCoverageHash(
  entries: readonly MemoryExtractionEventEntry[],
  fromSeq: number,
  throughSeq: number,
): string {
  return createHash('sha256')
    .update(JSON.stringify(
      entries
        .filter(entry => entry.seq > fromSeq && entry.seq <= throughSeq)
        .map(entry => [entry.seq, `${entry.event.role}:${entry.event.author}:${entry.event.text?.length ?? 0}`]),
    ))
    .digest('hex')
}

/**
 * Content-hash gap identity fallback (used when the proposal cited no gapId):
 * `gap_` + the first 24 hex chars of the normalized content's sha256, so two
 * sessions proposing byte-identical normalized facts land on one ledger entry.
 */
export function memoryGapIdForContent(content: string): string | undefined {
  const normalized = normalizeProposedMemoryText(content)
  if (normalized === undefined) return undefined
  return `gap_${createHash('sha256').update(normalized).digest('hex').slice(0, GAP_CONTENT_HASH_HEX)}`
}

/** Distinct session ids among sightings (a session never counts twice). */
function distinctSessionIds(sightings: readonly { readonly sessionId: string }[]): number {
  return new Set(sightings.map(sighting => sighting.sessionId)).size
}

function validSnapshot(snapshot: MemoryExtractionSourceSnapshot): boolean {
  return (
    typeof snapshot.sessionId === 'string' && snapshot.sessionId.length > 0
    && Number.isSafeInteger(snapshot.boundarySeq) && snapshot.boundarySeq >= 0
  )
}
