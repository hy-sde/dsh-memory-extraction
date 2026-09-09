/**
 * Evidence planning for automatic memory extraction: which session events are
 * Memory evidence (user-authored text only), how the bounded evidence index is
 * fitted, and the same-session history search that localizes elliptical
 * assertions. Ported from Maka `memory-extraction-evidence.ts`; provider-prefix
 * binding is dropped (the bounded evidence text is authoritative for both the
 * model and admission — see the package README deviation note).
 * @module @hy-sde-org/dsh-memory-extraction/evidence
 */

import type {
  MemoryCoveragePlan,
  MemoryEvidenceCitation,
  MemoryExtractionEventEntry,
  MemoryExtractionEvidence,
  MemoryExtractionTextEvent,
} from './types.ts'

export const MAX_MEMORY_EVIDENCE_JSON_CHARS = 12_000
export const MAX_EVIDENCE_TEXT_CHARS = 4_000
export const MIN_EVIDENCE_TEXT_CHARS = 64
export const MAX_LOCALIZED_TURNS = 7
export const MAX_LOCALIZED_CONTEXT_CHARS = 12_000
export const MAX_LOCALIZED_EVENT_CHARS = 2_000

/**
 * Plan one complete trigger range. Tool and runtime-control events produce no
 * evidence but stay in the range so the session cursor crosses them instead of
 * reconsidering them. If every user evidence record cannot fit the bounded
 * evidence index, fail closed instead of silently consuming part of the range.
 */
export function planMemoryCoverage(
  pendingEntries: readonly MemoryExtractionEventEntry[],
  options: { readonly maxEvidenceJsonChars?: number } = {},
): MemoryCoveragePlan | undefined {
  if (pendingEntries.length === 0) return undefined
  const budget = options.maxEvidenceJsonChars ?? MAX_MEMORY_EVIDENCE_JSON_CHARS
  const coverage = bindProviderVisibleEvidence(
    projectMemoryExtractionEvidence(pendingEntries.map(entry => entry.event)),
  )
  const fitted = fitMemoryExtractionEvidence(coverage, budget)
  if (!fitted) return undefined
  const fittedRefs = new Set(fitted.map(entry => entry.sourceRef))
  if (coverage.some(entry => !fittedRefs.has(entry.sourceRef))) return undefined
  return { entries: [...pendingEntries], evidence: fitted }
}

/** Projects only stable user-authored text into Memory evidence. */
export function projectMemoryExtractionEvidence(
  events: readonly MemoryExtractionTextEvent[],
): readonly MemoryExtractionEvidence[] {
  const projected: MemoryExtractionEvidence[] = []
  for (const event of events) {
    if (event.role !== 'user' || event.author !== 'user') continue
    const fullText = normalizeEvidenceText(event.text ?? '')
    if (!fullText) continue
    projected.push({
      sourceRef: `event:${event.seq}`,
      type: 'user_message',
      text: boundedEvidenceText(fullText, undefined),
      events: [event],
    })
  }
  return projected
}

/**
 * Keep every evidence record represented while shrinking supplemental text to
 * the actual serialized JSON budget. `undefined` means even the record
 * identities cannot fit and the cursor must not advance.
 */
export function fitMemoryExtractionEvidence(
  evidence: readonly MemoryExtractionEvidence[],
  maxJsonChars = MAX_MEMORY_EVIDENCE_JSON_CHARS,
): readonly MemoryExtractionEvidence[] | undefined {
  if (!Number.isSafeInteger(maxJsonChars) || maxJsonChars < 1) return undefined
  if (memoryExtractionEvidenceJsonSize(evidence) <= maxJsonChars) return evidence
  let low = MIN_EVIDENCE_TEXT_CHARS
  let high = MAX_EVIDENCE_TEXT_CHARS
  let best: readonly MemoryExtractionEvidence[] | undefined
  while (low <= high) {
    const cap = Math.floor((low + high) / 2)
    const candidate = evidence.map(entry => ({
      ...entry,
      text: sliceCodePoints(entry.text, cap),
    }))
    if (memoryExtractionEvidenceJsonSize(candidate) <= maxJsonChars) {
      best = candidate
      low = cap + 1
    } else {
      high = cap - 1
    }
  }
  return best
}

export function memoryExtractionEvidenceJsonSize(evidence: readonly MemoryExtractionEvidence[]): number {
  return JSON.stringify(renderMemoryExtractionEvidence(evidence)).length
}

/** The bounded evidence index rendered into the pipeline prompts. */
export function renderMemoryExtractionEvidence(
  evidence: readonly MemoryExtractionEvidence[],
): readonly {
  readonly sourceRef: string
  readonly type: 'user_message'
  readonly observedAt: number
  readonly text: string
}[] {
  return evidence.map(entry => ({
    sourceRef: entry.sourceRef,
    type: entry.type,
    observedAt: minuteTimestamp(Math.max(0, ...entry.events.map(event => event.time))),
    text: entry.text,
  }))
}

/** Present for parity with Maka's port shape; kept as the binding hook. */
function bindProviderVisibleEvidence(
  evidence: readonly MemoryExtractionEvidence[],
): readonly MemoryExtractionEvidence[] {
  return evidence
}

/**
 * Rank matching turns by term coverage and recency, then add a one-turn
 * neighborhood. Applies over the same bounded event window (`throughSeq`).
 * A "turn" is the adapter-declared `turn` id when present (DSH turn numbers);
 * otherwise each text event is its own group.
 */
export function searchSameSessionMemoryHistory(
  entries: readonly MemoryExtractionEventEntry[],
  throughSeq: number,
  search: { readonly terms: readonly string[]; readonly roles?: readonly string[] },
  afterSeq = 0,
): readonly MemoryExtractionEventEntry[] {
  const eligible = entries.filter(({ seq, event }) =>
    seq > afterSeq
    && seq <= throughSeq
    && (event.text !== undefined && event.text.length > 0)
    && ((event.role === 'user' && event.author === 'user')
      || (event.role === 'assistant' && event.author === 'model')))
  const turns: Array<{ key: string; entries: MemoryExtractionEventEntry[] }> = []
  for (const entry of eligible) {
    const key = entry.event.turn !== undefined ? `t${entry.event.turn}` : `e${entry.seq}`
    const last = turns.at(-1)
    if (last?.key === key) last.entries.push(entry)
    else turns.push({ key, entries: [entry] })
  }

  const terms = search.terms.map(term => normalizeEvidenceText(term).toLowerCase())
  const allowedRoles = search.roles ? new Set(search.roles) : undefined
  const hits = turns
    .map((turn, index) => ({
      index,
      score: terms.filter(term =>
        turn.entries.some((entry) => {
          if (allowedRoles && !allowedRoles.has(historyRole(entry.event))) return false
          return normalizeEvidenceText(entry.event.text ?? '').toLowerCase().includes(term)
        })).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)

  const selected = new Set<number>()
  for (const hit of hits) {
    for (const index of [hit.index, hit.index - 1, hit.index + 1]) {
      if (index < 0 || index >= turns.length || selected.has(index)) continue
      if (selected.size >= MAX_LOCALIZED_TURNS) break
      selected.add(index)
    }
    if (selected.size >= MAX_LOCALIZED_TURNS) break
  }
  return [...selected]
    .sort((left, right) => left - right)
    .flatMap(index => turns[index]?.entries ?? [])
}

/** Bounded user/assistant text used only to interpret elliptical user evidence. */
export function renderMemoryLocalizationContext(
  entries: readonly MemoryExtractionEventEntry[],
): string {
  let remaining = MAX_LOCALIZED_CONTEXT_CHARS
  const rendered: string[] = []
  for (const { seq, event } of entries) {
    if (remaining <= 0 || event.text === undefined || event.text.length === 0) continue
    const role = historyRole(event)
    const text = sliceCodePoints(normalizeEvidenceText(event.text), MAX_LOCALIZED_EVENT_CHARS)
    if (!text) continue
    const line = `[${role} event:${seq}] ${text}`
    const bounded = sliceCodePoints(line, remaining)
    rendered.push(bounded)
    remaining -= Array.from(bounded).length
  }
  return rendered.join('\n')
}

/** Resolve the admission evidence map for one coverage plan. */
export function evidenceByRef(
  evidence: readonly MemoryExtractionEvidence[],
): ReadonlyMap<string, MemoryExtractionEvidence> {
  return new Map(evidence.map(entry => [entry.sourceRef, entry]))
}

/** Whether one citation's quote is verbatim inside its referenced evidence. */
export function evidenceContainsCitation(
  citation: MemoryEvidenceCitation,
  evidence: ReadonlyMap<string, MemoryExtractionEvidence>,
): boolean {
  const source = evidence.get(citation.sourceRef)
  if (!source) return false
  const quote = normalizeEvidenceText(citation.quote)
  if (!quote) return false
  return source.text.includes(quote)
}

function boundedEvidenceText(
  value: string,
  terms: readonly string[] | undefined,
): string {
  const codePoints = Array.from(value)
  if (codePoints.length <= MAX_EVIDENCE_TEXT_CHARS) return value
  const normalizedTerms = terms
    ?.map(term => normalizeEvidenceText(term).toLowerCase())
    .filter(Boolean)
  const lower = value.toLowerCase()
  const hit = normalizedTerms
    ?.map(term => lower.indexOf(term))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0]
  if (hit === undefined) return codePoints.slice(0, MAX_EVIDENCE_TEXT_CHARS).join('')
  const before = Math.floor(MAX_EVIDENCE_TEXT_CHARS / 3)
  const start = Math.max(0, Array.from(value.slice(0, hit)).length - before)
  return codePoints.slice(start, start + MAX_EVIDENCE_TEXT_CHARS).join('')
}

export function normalizeEvidenceText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim()
}

export function minuteTimestamp(value: number): number {
  return Math.floor(value / 60_000) * 60_000
}

export function historyRole(event: MemoryExtractionTextEvent): 'user' | 'assistant' {
  return event.role === 'assistant' ? 'assistant' : 'user'
}

export function sliceCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('')
}

/** Event identity of one entry, used by the coverage hash. */
export function coverageEntryIdentity(entry: MemoryExtractionEventEntry): [number, string] {
  const label = entry.event.text !== undefined && entry.event.text.length > 0
    ? `${entry.event.role}:${entry.event.author}`
    : entry.event.role
  return [entry.seq, label]
}

/** Sort helper retained for tests and derived projections. */
export function sortEntriesBySeq(entries: readonly MemoryExtractionEventEntry[]): MemoryExtractionEventEntry[] {
  return [...entries].sort((left, right) => left.seq - right.seq)
}
