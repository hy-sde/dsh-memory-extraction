import { describe, expect, it } from 'vitest'
import {
  MAX_ITEM_CONTENT_CHARS,
  admitMemoryProposalItem,
  buildFirstMemoryProposalPrompt,
  buildMemoryCanonicalizationPrompt,
  deterministicMemoryPolicyRejection,
  normalizeProposedMemoryText,
  parseLocalizedMemoryProposal,
  parseMemoryCanonicalization,
  parseMemoryProposal,
} from '../src/proposal.ts'
import { evidenceByRef, projectMemoryExtractionEvidence } from '../src/evidence.ts'
import type { MemoryExtractionTextEvent } from '../src/types.ts'

/**
 * Ported semantics of Maka's memory-extraction-proposal specs: strict JSON
 * parsing, verbatim quote admission, deterministic policy rejection, and
 * canonicalization shape checking.
 */

function evidenceFrom(text: string) {
  const event: MemoryExtractionTextEvent = {
    seq: 1, role: 'user', author: 'user', text, time: 1_000,
  }
  return evidenceByRef(projectMemoryExtractionEvidence([event]))
}

describe('parseMemoryProposal', () => {
  it('parses complete, search_required, and cannot_resolve shapes', () => {
    const complete = parseMemoryProposal(
      '{"status":"complete","incidents":[{"content":"the pipeline uses sqlite","evidence":[{"sourceRef":"event:1","quote":"sqlite"}]}]}',
    )
    expect(complete).toEqual({
      status: 'complete',
      incidents: [{ content: 'the pipeline uses sqlite', evidence: [{ sourceRef: 'event:1', quote: 'sqlite' }] }],
    })

    const search = parseMemoryProposal(
      '{"status":"search_required","search":{"terms":["the variable"],"roles":["user","assistant"]}}',
    )
    expect(search).toEqual({ status: 'search_required', search: { terms: ['the variable'], roles: ['user', 'assistant'] } })

    expect(parseMemoryProposal('{"status":"cannot_resolve"}')).toEqual({ status: 'cannot_resolve' })
  })

  it('fails closed on fences, extra keys, and malformed items', () => {
    expect(parseMemoryProposal('```json\n{"status":"cannot_resolve"}\n```')).toBeUndefined()
    expect(parseMemoryProposal('{"status":"complete","incidents":[],"extra":true}')).toBeUndefined()
    expect(parseMemoryProposal('{"status":"complete","incidents":[{"content":"x"}]}')).toBeUndefined()
    expect(parseMemoryProposal('{"status":"complete","incidents":[{"content":"x","evidence":[]}]}')).toBeUndefined()
    expect(parseMemoryProposal('not json')).toBeUndefined()
  })

  it('parses an optional gap-id citation and fails closed on malformed ids', () => {
    const parsed = parseMemoryProposal(
      '{"status":"complete","incidents":[{"content":"the build needs pnpm","evidence":[{"sourceRef":"event:1","quote":"pnpm"}],"gapId":"gap_abc123"}]}',
    )
    expect(parsed).toEqual({
      status: 'complete',
      incidents: [{
        content: 'the build needs pnpm',
        evidence: [{ sourceRef: 'event:1', quote: 'pnpm' }],
        gapId: 'gap_abc123',
      }],
    })
    // Only engine-shaped ids: no leading gap_, spaces, or non-alphanumerics.
    expect(parseMemoryProposal(
      '{"status":"complete","incidents":[{"content":"x","evidence":[{"sourceRef":"event:1","quote":"x"}],"gapId":"whatever"}]}',
    )).toBeUndefined()
    expect(parseMemoryProposal(
      '{"status":"complete","incidents":[{"content":"x","evidence":[{"sourceRef":"event:1","quote":"x"}],"gapId":"GAP_ABC"}]}',
    )).toBeUndefined()
    expect(parseMemoryProposal(
      '{"status":"complete","incidents":[{"content":"x","evidence":[{"sourceRef":"event:1","quote":"x"}],"gapId":42}]}',
    )).toBeUndefined()
  })
})

describe('parseLocalizedMemoryProposal', () => {
  it('parses the two allowed shapes and rejects search_required', () => {
    expect(parseLocalizedMemoryProposal('{"status":"complete","incidents":[]}')).toEqual({ status: 'complete', incidents: [] })
    expect(parseLocalizedMemoryProposal('{"status":"cannot_resolve"}')).toEqual({ status: 'cannot_resolve' })
    expect(parseLocalizedMemoryProposal('{"status":"search_required","search":{"terms":["x"]}}')).toBeUndefined()
  })
})

describe('parseMemoryCanonicalization', () => {
  it('parses accepted/rejected results and enforces id bounds', () => {
    const parsed = parseMemoryCanonicalization(
      '{"results":[{"candidateId":"candidate_0","status":"accepted","content":"durable fact"},{"candidateId":"candidate_1","status":"rejected"}]}',
    )
    expect(parsed).toEqual({
      results: [
        { candidateId: 'candidate_0', status: 'accepted', content: 'durable fact' },
        { candidateId: 'candidate_1', status: 'rejected' },
      ],
    })
    expect(parseMemoryCanonicalization('{"results":[{"candidateId":"candidate_0","status":"accepted"}]}')).toBeUndefined()
    expect(parseMemoryCanonicalization('{"results":[]}')).toBeUndefined()
    expect(parseMemoryCanonicalization('{"results":[{"candidateId":"candidate_0","status":"maybe"}]}')).toBeUndefined()
  })
})

describe('admission', () => {
  it('admits only items whose every quote is verbatim in its referenced evidence', () => {
    const evidence = evidenceFrom('the quick brown fox jumps')
    const ok = admitMemoryProposalItem(
      { content: 'A fox jumped.', evidence: [{ sourceRef: 'event:1', quote: 'quick brown fox' }] },
      evidence,
    )
    expect(ok?.content).toBe('A fox jumped.')
    expect(ok?.citedSeqs).toEqual([1])

    const wrongRef = admitMemoryProposalItem(
      { content: 'A fox jumped.', evidence: [{ sourceRef: 'event:9', quote: 'quick brown fox' }] },
      evidence,
    )
    expect(wrongRef).toBeUndefined()

    const changed = admitMemoryProposalItem(
      { content: 'A fox jumped.', evidence: [{ sourceRef: 'event:1', quote: 'quick RED fox' }] },
      evidence,
    )
    expect(changed).toBeUndefined()

    const shortQuote = admitMemoryProposalItem(
      { content: 'A fox jumped.', evidence: [{ sourceRef: 'event:1', quote: 'browx' }] },
      evidence,
    )
    expect(shortQuote).toBeUndefined()
  })

  it('rejects secret-bearing items deterministically before and after canonicalization', () => {
    const secret = 'ghp_abcdefghijklmnopqrst'
    const item = { content: `use token ${secret}`, evidence: [{ sourceRef: 'event:1', quote: 'token' }] }
    expect(deterministicMemoryPolicyRejection(item)).toBe(true)
    expect(deterministicMemoryPolicyRejection({ content: 'a plain durable fact', evidence: [] })).toBe(false)
  })

  it('normalizes, neutralizes, and bounds proposed content', () => {
    expect(normalizeProposedMemoryText('  hello   world  ')).toBe('hello world')
    expect(normalizeProposedMemoryText('use <b>`x`</b>')).toBe('use bx/b')
    expect(Array.from(normalizeProposedMemoryText('x'.repeat(MAX_ITEM_CONTENT_CHARS + 50)) ?? ''))
      .toHaveLength(MAX_ITEM_CONTENT_CHARS)
    expect(normalizeProposedMemoryText('')).toBeUndefined()
  })
})

describe('prompts', () => {
  it('marks evidence as untrusted data and embeds the bounded index', () => {
    const evidence = evidenceFrom('a durable preference')
    const prompt = buildFirstMemoryProposalPrompt({ now: 1_700_000_000_000, evidence: [...evidence.values()] })
    expect(prompt).toContain('untrusted data')
    expect(prompt).toContain('"sourceRef":"event:1"')
    expect(prompt).toContain('a durable preference')
  })

  it('embeds open pending facts (with ids and session counts) only when provided', () => {
    const evidence = evidenceFrom('a durable preference')
    const withGaps = buildFirstMemoryProposalPrompt({
      now: 1_700_000_000_000,
      evidence: [...evidence.values()],
      openGaps: [{ id: 'gap_seeded', content: 'a pending fact', sessions: 2 }],
    })
    expect(withGaps).toContain('<open_pending_facts>')
    expect(withGaps).toContain('gap_seeded')
    expect(withGaps).toContain('"sessions":2')

    const withoutGaps = buildFirstMemoryProposalPrompt({ now: 1_700_000_000_000, evidence: [...evidence.values()] })
    expect(withoutGaps).not.toContain('<open_pending_facts>')
  })

  it('canonicalization prompt carries candidate ids for exact result mapping', () => {
    const prompt = buildMemoryCanonicalizationPrompt({
      now: 1_700_000_000_000,
      candidates: [{ candidateId: 'candidate_0', evidence: [{ sourceRef: 'event:1', quote: 'q', observedAt: 1 }] }],
    })
    expect(prompt).toContain('candidate_0')
    expect(prompt).toContain('untrusted data')
  })
})
