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
  parseLocalizedMemoryProposal,
  parseMemoryCanonicalization,
  parseMemoryProposal,
} from './proposal.ts'
import type {
  AdmittedMemoryItem,
  MemoryCoveragePlan,
  MemoryExtractionCursor,
  MemoryExtractionEventEntry,
  MemoryExtractionFailureClass,
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
  /** Commit admitted items into the project memory store; returns what was actually stored. */
  commitItems(input: {
    readonly sessionId: string
    readonly workspaceKey?: string
    readonly trigger: MemoryExtractionSourceSnapshot['trigger']
    readonly boundarySeq: number
    readonly items: readonly AdmittedMemoryItem[]
  }): { readonly committed: readonly string[] } | Promise<{ readonly committed: readonly string[] }>
  /** One bounded auxiliary model call. Implementations own the timeout signal. */
  generate(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot
    readonly prompt: string
    readonly stage: MemoryExtractionStage
  }): MemoryGenerateResult | Promise<MemoryGenerateResult>
  now?(): number
}

/** Max auxiliary model calls per range (Maka: 3). */
export const MAX_MEMORY_EXTRACTION_MODEL_CALLS = 3
/** One later retry after a settled failure, then discard (Maka keeps more states). */
export const MAX_FAILURE_ATTEMPTS = 2

type CoverageResult =
  | { readonly kind: 'committed'; readonly committed: readonly string[] }
  | {
    readonly kind: 'counted_failure'
    readonly failureClass: MemoryExtractionFailureClass
  }
  | { readonly kind: 'blocked' }

interface ModelBudget {
  remaining: number
}

export class MemoryExtractionEngine {
  constructor(private readonly ports: MemoryExtractionPorts) { }

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

    // Stage 1: proposal over the bounded evidence.
    let proposals: readonly MemoryProposalItem[] | undefined
    let localizedEvidence: MemoryCoveragePlan['evidence'] | undefined
    let interpretationContext: string | undefined
    const stageOne = await this.callModel(
      input.snapshot,
      buildFirstMemoryProposalPrompt({ now: input.now, evidence: coverage.evidence }),
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
    }> = []
    for (const proposal of proposals) {
      if (deterministicMemoryPolicyRejection(proposal)) continue
      const admitted = admitMemoryProposalItem(proposal, evidenceMap)
      if (admitted === undefined) continue
      candidates.push({
        candidateId: `candidate_${candidates.length}`,
        item: proposal,
        admitted,
      })
    }
    if (candidates.length === 0) {
      await this.commitEmpty(input.snapshot, input.operationId, input.expectedCursor, input.throughSeq)
      return { kind: 'committed', committed: [] }
    }

    // Stage 2: canonicalization, then re-admission against the same evidence.
    const writes: AdmittedMemoryItem[] = []
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
      writes.push(admitted)
    }

    if (writes.length === 0) {
      await this.commitEmpty(input.snapshot, input.operationId, input.expectedCursor, input.throughSeq)
      return { kind: 'committed', committed: [] }
    }
    if (!(await this.allowed(input.snapshot))) return { kind: 'blocked' }

    // Commit order: items first (dedupe is the cross-store idempotency
    // backstop), then cursor, then receipt.
    const committed = await this.ports.commitItems({
      sessionId: input.snapshot.sessionId,
      ...input.snapshot.workspaceKey !== undefined
        ? { workspaceKey: input.snapshot.workspaceKey }
        : {},
      trigger: input.snapshot.trigger,
      boundarySeq: input.throughSeq,
      items: writes,
    })
    await this.ports.writeCursor({
      sessionId: input.snapshot.sessionId,
      processedSeq: input.throughSeq,
      updatedAt: this.now(),
    })
    await this.ports.writeReceipt({
      operationId: input.operationId,
      sessionId: input.snapshot.sessionId,
      status: 'extracted',
      items: [...committed.committed],
      committedAt: this.now(),
    })
    return { kind: 'committed', committed: committed.committed }
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

function validSnapshot(snapshot: MemoryExtractionSourceSnapshot): boolean {
  return (
    typeof snapshot.sessionId === 'string' && snapshot.sessionId.length > 0
    && Number.isSafeInteger(snapshot.boundarySeq) && snapshot.boundarySeq >= 0
  )
}
