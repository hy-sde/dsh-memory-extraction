<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-memory-extraction`](https://www.npmjs.com/package/@hy-sde-org/dsh-memory-extraction)
<!-- MIRROR-NOTE:END -->

# dsh-memory-extraction — automatic long-term-memory extraction for DeepSeek Harness

Standalone package `@hy-sde-org/dsh-memory-extraction`: automatic
long-term-memory extraction at compaction checkpoints for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). After
every `compaction/summary` boundary a bounded, fail-open pipeline projects the
**user-authored** text of the checkpointed range, proposes and canonicalizes
durable facts with auxiliary model calls (evidence-grounding,
proposal/admission/canonicalization, per-session cursors, cross-session
evidence floor), and commits admitted facts into the same project memory bank
`retain`/`learn` write — strictly additive to the explicit memory surface
(`retain` / `recall` / `reflect` / `memory_edit` / `learn` stay the
model-facing path).

| Identity | Value |
| --- | --- |
| Package | `@hy-sde-org/dsh-memory-extraction` |
| Plugin id | `memory-extraction` (the row you add by hand — the package ships no bundle row) |
| Plane | host — injects `memory` + `llm`, publishes nothing |
| Commit seam | `ctx.memory` (extracted facts land with `source: 'memory_extract'`) |

> **Based on [Apache Maka](https://github.com/apache/maka) (Apache License
> 2.0, © the Apache Software Foundation)** — the memory-extraction engine
> (evidence projection, proposal/admission/canonicalization, control store,
> compaction trigger) is ported from Maka (No. 2), upstream
> [`packages/runtime/src/memory-extraction.ts`](https://github.com/apache/maka/blob/main/packages/runtime/src/memory-extraction.ts).
> The DSH integration is derived from the
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) codebase
> (MIT, © 2026 DeepSeek); each derived file carries the attribution in its
> header. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Why

Without this package, durable memory only grows when the model remembers to
call `retain`/`learn`. This engine watches every compaction checkpoint instead:
facts the user states across a session are projected, verified, and committed
automatically, so memory survives compaction without manual discipline. The
load-bearing rules are ported from Maka and enforced by the engine:

- **Evidence is user-authored text only** — assistant text is
  interpretation-only; tool calls/results and reasoning are opaque. Evidence is
  bounded (12 000 chars JSON / 4 000 chars per record / 64 records) and
  fail-closed on overflow.
- **Admission is verified** — proposal → admission (verbatim-quote check
  against the bounded evidence + secret rejection) → canonicalization →
  re-admission, at most 3 auxiliary model calls per range with a 60 s timeout;
  failures are contained (fail-open at the runtime boundary — compaction is
  never blocked).
- **The cursor only moves to a committed boundary** — write order is items →
  cursor → receipt, so a crash can never double-process; operation ids are
  deterministic (`memory_` + sha256 of `{sessionId, trigger, boundarySeq}`),
  and receipts make replays no-ops.
- **Subagents are excluded** — child-agent compactions never extract
  (`excludeSubagents: true` default).
- **Cross-session evidence floor** — a fact only commits once `minGapEvidence`
  **distinct** sessions (default 2) have proposed the same durable fact;
  uncorroborated facts stay in the gap ledger as open pending facts and expire
  after `gapLedgerMaxAgeMs` (default 90 d).

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- a DeepSeek Harness release carrying the `0.2.0-rc.2` peer range —
  `@deepseek-ai/cordis ~4.0.4` and `@deepseek-ai/dsh-compaction`,
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-storage`
  `^0.2.0-rc.2` — including the standard `dsh` CLI;
- the [`@hy-sde-org/dsh-memory`](../dsh-memory/README.md) plugin mounted —
  extraction commits into its `ctx.memory` bank;
- a storage backend exposing a `kv` facet — the shipped `sqlite` backend does;
  `storage-json` does not. Nothing else: no API keys (the auxiliary calls reuse
  the session's routed model unless you configure `provider`/`model`).

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh pnpm
dsh --version
```

## Quick start

The package ships **no `dsh.bundle.patch`**, so mounting is two steps: install
the package, then add one row to your profile's host composition by hand.

### Route A — published npm package

```bash
dsh plugin --profile web add @hy-sde-org/dsh-memory-extraction
```

Because the package declares no bundle, the CLI installs it as a **plain
profile dependency** and warns `declares no dsh.bundle — installed as a plain
dependency, not a profile layer`. No row is applied automatically — add it to
the host composition (the profile's `cordis.patch.yml` patch layer, loaded
before any session):

```yaml
- insert:
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

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
PACKAGE_TARBALL="$(cd dsh-memory-extraction/packages/memory-extraction && pnpm pack --silent)"
dsh plugin --profile web add "dsh-memory-extraction/packages/memory-extraction/$PACKAGE_TARBALL"
```

`pnpm pack` runs the normal `prepack` build and produces a tarball containing
`dist/`. The install lands as a plain profile dependency exactly as in
Route A — add the host-composition row above the same way.

### Verify the composed configuration

```bash
dsh web --dump-config
```

The composed tree must show the `memory-extraction` row loading
`@hy-sde-org/dsh-memory-extraction`.

### Run

```bash
dsh web
```

After the next compaction checkpoint that contains user-authored text, the
engine proposes, verifies, and commits durable facts into the project memory
bank with `source: 'memory_extract'` — ask the agent to `recall` or `reflect`
and the auto-extracted entries are there. The plugin boots asynchronously; if
the configured storage backend is missing it logs and stays inert instead of
failing composition.

### Uninstall

Remove the row you added to the host composition, then:

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-memory-extraction
```

## What the package does

The engine is a **host-plane** Cordis plugin (`inject: ['memory', 'llm']`, it
publishes nothing): one process opens the `memory_extraction` control unit
once (tables `cursors` / `receipts` / `failures` / `gaps` over a `KvUnit`) and
observes every session's events through an unscoped `ctx.on('session/event')`
listener. On each `compaction/summary` boundary it runs the per-session
serialized pipeline — project evidence, propose, admit, canonicalize,
re-admit, commit — and never blocks the compaction listener. Committed facts
go through the `ctx.memory` commit surface with a dedupe probe, landing in the
same bank `retain`/`learn` write; deferred facts stay sighted in the gap
ledger and are shown to later proposal passes (the model cites a `gapId`
instead of coining a paraphrase). The engine itself is pure and testable
without cordis:

```ts
import { MemoryExtractionEngine } from '@hy-sde-org/dsh-memory-extraction'

const engine = new MemoryExtractionEngine(ports) // readGate/readEvents/cursor+receipt+failure/commitItems/generate
const result = await engine.execute(snapshot)   // never throws; idempotent by operation id
```

## Configuration

All options are optional; the row's `config:` fills the defaults.

| Option | Default | Purpose |
| --- | --- | --- |
| `backend` | `sqlite` | storage backend hosting the control unit; must expose a `kv` facet |
| `enabled` | `true` | master switch |
| `excludeSubagents` | `true` | child-agent compactions never extract |
| `provider`, `model` | unset | auxiliary model route; unset uses the session's routed request header. A cheap auxiliary model is recommended for large deployments |
| `importance` | `0.5` | bank importance for auto-extracted facts |
| `dedupe` | `true` | probe the bank before committing duplicates |
| `timeoutMs` | `60000` | per-range auxiliary call budget (≤ 3 calls) |
| `minGapEvidence` | `2` | distinct sessions before a fact commits; `0` disables the floor |
| `gapLedgerMaxAgeMs` | `7776000000` | sightings older than this stop counting (90 d); `0` disables the ledger |

## Compatibility

| Component | Supported contract |
| --- | --- |
| Node.js | 22.19 or newer (`engines.node >=22.19.0`) |
| DeepSeek Harness | `0.2.0-rc.2` peer range (`@deepseek-ai/cordis ~4.0.4`; `dsh-compaction`, `dsh-llm`, `dsh-session`, `dsh-storage` `^0.2.0-rc.2`) |
| Memory bank | `@hy-sde-org/dsh-memory` (`ctx.memory` seam) |
| Storage backend | must expose a `kv` facet — shipped `sqlite` yes, `storage-json` no |

Upstream seam-contract changes require a new package release and contract
review.

## Development

```bash
pnpm install
pnpm check        # strict typecheck of packages/memory-extraction
pnpm test         # vitest run
pnpm build        # tsc -> dist
pnpm pack:all     # pack the publishable package
```

The engine is a pure state machine (`src/engine.ts`) over injected ports, so
the state machine, evidence projection, and parsers are testable without
cordis; `src/runtime.ts` is the only host wiring. See
[`packages/memory-extraction/README.md`](packages/memory-extraction/README.md)
(English | [中文](packages/memory-extraction/README.zh.md)) for the
implementation tour.

## License and attribution

This package is licensed MIT — see [LICENSE](LICENSE). Code derived from the
DeepSeek Harness codebase is MIT (© 2026 DeepSeek); the memory-extraction
engine is a port of Apache Maka (No. 2) under the Apache License 2.0 (© the
Apache Software Foundation) — the Apache License 2.0 text applies to the
derived Maka modules, and the rest of the repository is MIT. The upstream
notice text is reproduced in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

This plugin is a separate installable package; the harness remains the
property of its own project.
