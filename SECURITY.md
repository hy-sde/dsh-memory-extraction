# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-session-url` is a read-only scheme handler: it resolves
  `session://` URLs against the mounted `ctx.sessionQuery` service and never
  touches the filesystem. Session ids are opaque branded strings used only as
  the URL host — they are never interpreted as filesystem segments.
- Every resolved resource is bounded (600-event transcripts for `read`,
  12 000 for `grep` consumers, 200-session listings, 128 KiB per-event JSON
  caps) so a hostile or enormous session log cannot exhaust memory through
  the handler; oversized events degrade to a text notice instead of failing.
- `session://search` delegates to the deployment's content-search policy:
  when the session-query index disables content search (`openAt: 'never'`),
  the handler returns an explanatory note rather than leaking into the index.
- The vendored `src/vendor/internal-urls/` modules (types/parse/router) are
  pure local parsing/registry code with no I/O of their own; keep them in
  sync with the fork when updating.
