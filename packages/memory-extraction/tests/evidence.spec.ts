import { describe, expect, it } from 'vitest'
import {
  MAX_EVIDENCE_TEXT_CHARS,
  evidenceContainsCitation,
  fitMemoryExtractionEvidence,
  memoryExtractionEvidenceJsonSize,
  planMemoryCoverage,
  projectMemoryExtractionEvidence,
  renderMemoryLocalizationContext,
  searchSameSessionMemoryHistory,
} from '../src/evidence.ts'
import type { MemoryExtractionEventEntry, MemoryExtractionTextEvent } from '../src/types.ts'

/**
 * Ported semantics of Maka's memory-extraction-evidence specs: user-authored
 * text only; bounded and fail-closed evidence; quote verification; and the
 * same-session localization search.
 */

function textEvent(seq: number, role: 'user' | 'assistant' | 'other', author: 'user' | 'model' | 'plugin' | 'tool', text?: string, turn?: number): MemoryExtractionTextEvent {
  return {
    seq,
    role,
    author,
    ...text !== undefined ? { text } : {},
    ...turn !== undefined ? { turn } : {},
    time: 1_000 + seq,
  }
}

function entry(seq: number, event: MemoryExtractionTextEvent): MemoryExtractionEventEntry {
  return { seq, event }
}

function user(seq: number, text: string, turn?: number): MemoryExtractionEventEntry {
  return entry(seq, textEvent(seq, 'user', 'user', text, turn))
}

describe('projectMemoryExtractionEvidence', () => {
  it('keeps only user-authored text and normalizes it', () => {
    const evidence = projectMemoryExtractionEvidence([
      textEvent(1, 'user', 'user', '  A  durable   preference.  '),
      textEvent(2, 'user', 'plugin', 'plugin checkpoint'),
      textEvent(3, 'assistant', 'model', 'assistant advice'),
      textEvent(4, 'other', 'tool'),
      textEvent(5, 'user', 'user', ''),
    ])
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.sourceRef).toBe('event:1')
    expect(evidence[0]?.type).toBe('user_message')
    expect(evidence[0]?.text).toBe('A durable preference.')
  })

  it('bounds record text at MAX_EVIDENCE_TEXT_CHARS code points', () => {
    const long = 'x'.repeat(MAX_EVIDENCE_TEXT_CHARS + 500)
    const evidence = projectMemoryExtractionEvidence([textEvent(1, 'user', 'user', long)])
    expect(Array.from(evidence[0]?.text ?? '')).toHaveLength(MAX_EVIDENCE_TEXT_CHARS)
  })
})

describe('planMemoryCoverage', () => {
  it('returns undefined for an empty range', () => {
    expect(planMemoryCoverage([])).toBeUndefined()
  })

  it('keeps non-evidence entries in the range and plans the evidence', () => {
    const plan = planMemoryCoverage([
      entry(0, textEvent(0, 'other', 'tool')),
      user(1, 'The pipeline uses X.'),
      entry(2, textEvent(2, 'assistant', 'model', 'yes')),
    ])
    expect(plan?.entries.map(candidate => candidate.seq)).toEqual([0, 1, 2])
    expect(plan?.evidence.map(candidate => candidate.sourceRef)).toEqual(['event:1'])
  })

  it('fails closed when even the minimum cap cannot fit the evidence budget', () => {
    const budget = 120
    const plan = planMemoryCoverage([
      user(1, 'a'.repeat(1_000)),
      user(2, 'b'.repeat(1_000)),
    ], { maxEvidenceJsonChars: budget })
    expect(plan).toBeUndefined()
  })

  it('shrinks long records with a binary search to fit the budget', () => {
    const plan = planMemoryCoverage([user(1, 'z'.repeat(20_000))], { maxEvidenceJsonChars: 2_000 })
    expect(plan).toBeDefined()
    expect(Array.from(plan?.evidence[0]?.text ?? '').length).toBeLessThan(2_000)
    expect(memoryExtractionEvidenceJsonSize(plan?.evidence ?? [])).toBeLessThanOrEqual(2_000)
  })
})

describe('fitMemoryExtractionEvidence', () => {
  it('returns the input when it already fits', () => {
    const evidence = projectMemoryExtractionEvidence([textEvent(1, 'user', 'user', 'short')])
    expect(fitMemoryExtractionEvidence(evidence)).toBe(evidence)
  })

  it('returns undefined for an invalid budget', () => {
    const evidence = projectMemoryExtractionEvidence([textEvent(1, 'user', 'user', 'short')])
    expect(fitMemoryExtractionEvidence(evidence, 0)).toBeUndefined()
  })
})

describe('evidenceContainsCitation', () => {
  it('accepts a verbatim quote and rejects a changed quote', () => {
    const evidence = projectMemoryExtractionEvidence([textEvent(1, 'user', 'user', 'the quick brown fox')])
    const map = new Map(evidence.map(candidate => [candidate.sourceRef, candidate]))
    expect(evidenceContainsCitation({ sourceRef: 'event:1', quote: 'quick brown fox' }, map)).toBe(true)
    expect(evidenceContainsCitation({ sourceRef: 'event:1', quote: 'quick red fox' }, map)).toBe(false)
    expect(evidenceContainsCitation({ sourceRef: 'event:9', quote: 'quick brown fox' }, map)).toBe(false)
  })
})

describe('searchSameSessionMemoryHistory', () => {
  it('ranks turns by term coverage plus one-turn neighborhood', () => {
    const entries = [
      user(1, 'foo discussion in turn one.', 1),
      user(2, 'turn two, no term.', 2),
      user(3, 'turn three, none.', 3),
      user(4, 'turn four, none.', 4),
      user(5, 'foo again in turn five.', 5),
      user(6, 'turn six, none.', 6),
      user(7, 'turn seven, none.', 7),
    ]
    const hits = searchSameSessionMemoryHistory(entries, 7, { terms: ['foo'] })
    // Hits: turns 1 and 5. Neighborhoods cover turns 1-2 and 4-6;
    // the 3-turn gap between hits keeps turn 3 (and 7) outside.
    expect(hits.map(candidate => candidate.seq)).toEqual([1, 2, 4, 5, 6])
  })

  it('respects throughSeq, roles filter, and excludes plugin/tool text', () => {
    const entries = [
      user(1, 'foo discussion', 1),
      entry(2, textEvent(2, 'user', 'plugin', 'foo inside checkpoint', 1)),
      entry(3, textEvent(3, 'other', 'tool', 'foo in tool output', 2)),
      user(4, 'more foo', 2),
    ]
    const hits = searchSameSessionMemoryHistory(entries, 3, { terms: ['foo'], roles: ['user'] })
    expect(hits.map(candidate => candidate.seq)).toEqual([1])

    const full = searchSameSessionMemoryHistory(entries, 4, { terms: ['foo'] })
    // Plugin/tool-authored text never counts as searchable history.
    expect(full.map(candidate => candidate.seq)).toEqual([1, 4])
  })

  it('bounds localized context rendering by chars', () => {
    const entries = [user(1, 'a'.repeat(3_000), 1)]
    const context = renderMemoryLocalizationContext(entries)
    expect(Array.from(context).length).toBeLessThanOrEqual(12_000)
    expect(context).toContain('event:1')
  })
})
