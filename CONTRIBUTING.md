# Contributing

Thanks for helping with `dsh-session-url`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No unpublished dependencies.** The only fork-only dependency of the
  original package (`@deepseek-ai/dsh-internal-urls`) is vendored into
  `src/vendor/internal-urls/` (types + parse + router) with a keep-in-sync
  header. Runtime deps are published packages only:
  `@deepseek-ai/dsh-session-query` (dependency + peer) and
  `@deepseek-ai/dsh-session` (peer), plus the `@deepseek-ai/cordis` peer.
  Do not add deps on packages that are not on npm.
- **Stay pinned to the fork.** This repo mirrors
  `packages/session-query/session-url` in the
  [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness);
  when the fork evolves the handler, bring the change here too (and vice
  versa). Keep the vendored `internal-urls` files byte-identical to the fork
  when you sync them.
- Keep `check` strict: the repo type-checks `src` and `tests` together.
- Never weaken the test suite: the spec exercises the handler against the
  real (vendored) parse/router, not fakes.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (src + tests)
pnpm -r test       # handler + router-integration tests
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish @hy-sde-org/dsh-session-url
```
