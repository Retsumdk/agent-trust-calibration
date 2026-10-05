# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-05

First release. `agent-trust-calibration` scores agent reliability from outcome
history, detects drift against the agent's own baseline, gates access on
(score, confidence, drift), and records every mutation in a hash-chained audit
ledger. Zero runtime dependencies.

### Added

- **Recency-weighted scoring** (`src/scoring.ts`) — exponential decay with a
  configurable half-life (7 days by default), so a score tracks current
  behaviour rather than a lifetime average.
- **Kish confidence** (`src/scoring.ts`) — confidence is derived from the
  effective sample size, so a few lucky successes cannot unlock the permissions
  that sustained evidence unlocks.
- **Statistical drift detection** (`src/drift.ts`) — a two-population z-test
  compares the agent's recent window against its own baseline, with explicit
  `stable` / `drifting` / `insufficient-data` states.
- **Policy engine** (`src/policy.ts`) — maps (score, confidence, drift) onto
  `allow` / `require-approval` / `deny`, and every decision carries
  human-readable reasons.
- **Hash-chained audit ledger** (`src/audit.ts`, `src/hashing.ts`) —
  append-only and tamper-evident, and it tolerates a torn final line.
- **Registry and persistence** (`src/registry.ts`, `src/persistence.ts`) — an
  agent registry with JSON state and audit files.
- **CLI** (`src/cli.ts`) — `demo`, `record`, `score`, `decide`, `drift` and
  ledger-verification commands, shipped as the `agent-trust-calibration` bin.
- **HTTP server** (`src/server.ts`) — read and write endpoints over the same
  registry.
- **Tests** (`tests/`) — 40 unit tests across scoring, drift, policy, audit and
  registry, run with `bun test`.
- **CI** (`.github/workflows/ci.yml`) — typecheck, tests, build and a CLI demo
  smoke test on every push and pull request.

### Notes

- Requires Node >= 20. TypeScript is the only dev dependency.
- Until the package is on the npm registry, install it from GitHub:
  `npm install github:Retsumdk/agent-trust-calibration`

[1.0.0]: https://github.com/Retsumdk/agent-trust-calibration/releases/tag/v1.0.0
