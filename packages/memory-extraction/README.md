# @hy-sde-org/dsh-memory-extraction

English | [中文](README.zh.md)

## Summary

`dsh-memory-extraction` is the DSH port of Maka's automatic memory-extraction
trigger: after every `compaction/summary` event (a checkpoint boundary), a
bounded, fail-open pipeline projects the **user-authored** text of the
checkpointed range, proposes and canonicalizes durable facts with auxiliary
model calls, and commits admitted facts into the same project memory bank
`retain`/`learn` write. It is strictly **additive** to DSH's explicit memory
surface: the `retain`/`learn`/`memory_edit` tools stay the model-facing path
and the port intentionally reserves (does not port) Maka's
`memory_remember`/`memory_extract` verbs.

The package is a **host-plane** Cordis plugin (`inject: ['memory', 'llm']`,
publishes nothing): one process opens the `memory_extraction` control unit once
and observes every session's events through an unscoped `ctx.on('session/event')`
listener (the scope filter admits unscoped listeners globally). Runs are
per-session serialized and never block the compaction listener.

### Load-bearing rules (ported from Maka)

1. **Evidence is user-authored text only** — project `user/message` events whose
   `source.kind === 'user'`; assistant text is interpretation-only; tool
   calls/results, reasoning, and plugin checkpoints are opaque. Evidence is
   bounded (12 000 chars JSON / 4 000 chars per record / 64 records) and
   **fail-closed** on overflow.
2. **Admission is verified** — proposal → admission (verbatim quote check
   against the bounded evidence + secret rejection) → canonicalization →
   re-admission, at most **3 auxiliary model calls** per range with a 60 s
   timeout; failures are contained (fail-open at the runtime boundary).
3. **The cursor only moves to a committed boundary** — empty ranges still
   advance (a no-op receipt, no model call); a failed range becomes one pending
   record retried by the next trigger and then discarded. Write order is
   items → cursor → receipt, so a crash between cursor and receipt can never
   double-process.
4. **Idempotency is deterministic** — operation id = `memory_` + sha256 of
   `{sessionId, trigger, boundarySeq}`; receipts make replays no-ops and the
   commit-side dedupe probe heals a crash between items and receipt.
5. **Subagents are excluded** — the gate re-checks after every model call and
   rejects child sessions by default (`excludeSubagents: true`).
6. **Cross-session evidence floor (E1)** — a fact only commits once
   `minGapEvidence` **distinct** sessions (default 2; one session never counts
   twice, even across its own compactions) have proposed the same durable fact.
   Uncorroborated facts become `gaps` sighted in the ledger, shown to later
   proposal passes as open pending facts (the model cites a `gapId` instead of
   coining a paraphrase); identity falls back to the normalized content hash.
   A fact retires (covered) when it commits or is found already in the bank.
   Sightings older than `gapLedgerMaxAgeMs` (default 90 d) expire. Deferrals
   still advance the cursor and settle the receipt; reads/writes of the ledger
   take a config value of `0` off entirely (pre-E1 behavior).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The row belongs in the **host composition** — it injects host services
(`memory`, `llm`), opens the control unit once per process, and must observe
every session's events. There is no agent-preset contribution and no tool.

```yaml
# host composition (loaded before any session)
- id: memory-extraction
  name: '@hy-sde-org/dsh-memory-extraction'
  config:
    backend: sqlite           # storage backend hosting the control unit (default sqlite)
    enabled: true             # master switch (default true)
    excludeSubagents: true    # child-agent compactions never extract (default true)
    # provider: <cheap provider id>  # optional; unset uses the session's routed model config
    # model: <cheap model id>        # optional; unset uses the session's routed model config
    importance: 0.5           # bank importance for auto-extracted facts (default 0.5)
    dedupe: true              # probe the bank before committing duplicates (default true)
    timeoutMs: 60000          # auxiliary call timeout (default 60000)
    minGapEvidence: 2         # distinct sessions before a fact commits (default 2; 0 disables the floor)
    gapLedgerMaxAgeMs: 7776000000   # sightings older than this stop counting (default 90 d in ms)
```

Its storage backend must expose a `kv` facet (the shipped `sqlite` backend
does; `storage-json` does not) — the row above is the complete host wiring.
The engine itself is pure and testable without cordis:

```ts
import { MemoryExtractionEngine } from '@hy-sde-org/dsh-memory-extraction'

const engine = new MemoryExtractionEngine(ports) // readGate/readEvents/read+write cursor+receipt+failure/commitItems/generate
const result = await engine.execute(snapshot)   // never throws; idempotent by operation id
```

### Wiring

The plugin boots asynchronously: an effect opens the control unit via
`storage.backend.<backend>.kv.open(MemoryExtractionControlStore.descriptor)`
(`memory_extraction`, version 1, tables `cursors`/`receipts`/`failures`/`gaps`
— the gap table is additive and the version stays 1 because the storage-sqlite
backend rejects version bumps on existing media; `CREATE TABLE IF NOT EXISTS`
materializes it on upgrade) and
registers the `session/event` listener. A missing backend logs and leaves the
plugin inert instead of failing composition.

## Understand the implementation

- `src/evidence.ts` — bounded evidence projection, coverage planning
  (binary-search shrink, fail-closed overflow), the same-session localization
  search, and quote verification.
- `src/proposal.ts` — strict hand-rolled JSON parsers (complete /
  `search_required` / `cannot_resolve` / canonicalization), prompt builders that
  frame evidence as **untrusted data**, admission (verbatim quotes, min 4 chars,
  secret rejection, NFC + injection neutralization, 2 000-char content cap).
- `src/control.ts` — the durable cursor/receipt/failure/gap store over one
  `KvUnit` (single write chain; heal-on-open; write ordering documented).
- `src/engine.ts` — the state machine: idempotency receipt, gate, empty-range
  advance, one-retry-then-discard, 3-call budget, commit ordering.
- `src/events.ts` — the lossy DSH event projection (user/assistant text only,
  turn tracking for localization grouping).
- `src/memory-adapter.ts` — the commit surface over `ctx.memory`: a dedupe probe,
  then `save` with `source: 'memory_extract'`, plus the gate factory.
- `src/runtime.ts` — host wiring: per-session sequential queue, generate adapter
  (`BlockAssembler`, `AbortSignal.timeout`, routed provider/model override),
  sync/async port implementations over live services.

## Further Exploration

- The Maka source this was ported from: [`memory-extraction.ts`](https://github.com/apache/maka/blob/main/packages/runtime/src/memory-extraction.ts).
- The compaction lifecycle that emits the boundary events:
  `@deepseek-ai/dsh-compaction`.

## Model Experience

The pipeline adds up to 3 auxiliary model calls per checkpointed range with
user-authored text (proposal, optional localization, canonicalization), each
bounded by `timeoutMs`. Configuring `provider`/`model` to a cheap auxiliary
model is recommended for large deployments; when unset the session's routed
request header is used. The model never sees raw logs or tool results — only
the bounded, user-authored evidence plus a short localization context.

## Known Limitations and Deferred Work

- **One pending failure per session** (retry once, then discard) — Maka keeps
  richer failure states (e.g. evidence-growth retry), ported as a single later
  retry.
- **No persistent re-extraction** on evidence growth: a checkpoint that failed
  is retried once and then dropped.
- **Gap identity is model-cited or exact-hash** — a paraphrase the proposal
  pass does not link to an open pending fact via `gapId` falls back to the
  normalized content hash and stays pending until a byte-identical sighting (or
  an explicit cite) corroborates it. No lexical/semantic matching is done.
- **Deferred facts are not dedupe-probed** — a fact someone already
  `retain`ed that the extraction proposes never retires via the bank check; it
  retires when a second session cites it or its sighting expires.
- **Maka facets are not ported** (kind/temporal/scope/tags); every extracted
  fact lands with `source: 'memory_extract'` and the configured importance.
- **No per-verb tools**: `memory_remember`/`memory_extract` are reserved names;
  the explicit DSH memory tools remain the model-facing path.
- The dedupe probe relies on the local memory bank's `search` seeing previously
  committed rows (same-process semantics).
