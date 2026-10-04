# Agent Trust Calibration

[![CI](https://github.com/Retsumdk/agent-trust-calibration/actions/workflows/ci.yml/badge.svg)](https://github.com/Retsumdk/agent-trust-calibration/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Dynamic trust calibration for autonomous agents: recency-weighted performance scoring, statistical drift detection, confidence-gated access policy, and a hash-chained audit ledger. Zero runtime dependencies.

## The problem

Multi-agent systems hand live permissions — spending money, writing to production, contacting people — to agents whose reliability changes over time. A credential an agent earned last month can be obsolete today after a model update, a prompt change, or a shifting task distribution. Most systems treat trust as static (a one-time approval) or as a raw average (where February's successes permanently prop up June's failures). Neither is safe: the first never reacts to degradation, the second reacts far too slowly.

## The solution

`agent-trust-calibration` maintains a per-agent trust score that:

1. **Forgets gracefully** — every observation is weighted by exponential decay with a configurable half-life (default 7 days), so the score tracks *current* behavior, not lifetime averages.
2. **Knows how much it knows** — confidence is derived from the effective sample size (Kish formula), not the raw count. Three lucky successes cannot unlock the same permissions as thirty.
3. **Detects drift statistically** — a two-population z-test compares the agent's recent window against its own baseline. A degrading agent is flagged before its slowly-eroding average ever notices.
4. **Decides, with reasons** — a policy layer maps (score, confidence, drift) onto `allow` / `require-approval` / `deny`, and every decision carries human-readable reasons.
5. **Leaves a tamper-evident trail** — every mutation lands in a hash-chained, append-only audit ledger that refuses mid-file tampering and survives torn tails.

## How it works

```
             outcomes (success | partial | failure, optional quality 0..1)
                              │
                 ┌────────────▼────────────┐
                 │      TrustRegistry      │
                 │  (agents, ledger, IO)   │
                 └───┬─────────┬───────┬───┘
                     │         │       │
        ┌────────────▼──┐  ┌───▼──────────────┐
        │ computeScore  │  │  evaluateDrift   │
        │ decay-weighted│  │  two-population  │
        │ mean + Kish   │  │  z-test, recent  │
        │ confidence    │  │  window vs base  │
        └──────┬────────┘  └───┬──────────────┘
               └───────┬───────┘
                 ┌─────▼─────┐
                 │TrustPolicy│
                 │ thresholds│──► allow | require-approval | deny
                 └───────────┘
```

- **Scoring** (`src/scoring.ts`): each outcome weighs `0.5^(age / halfLife)`. The score is the weighted mean quality; confidence saturates at `N_eff / (N_eff + 5)`; the margin is the 95% half-width of a normal approximation, clamped to [0, 0.5].
- **Drift** (`src/drift.ts`): the last `windowSize` outcomes (default 10) form the recent window; everything before it is the baseline. The z-statistic uses pooled standard error `sqrt(varB/nB + varR/nR)`. Positive z means the agent got worse — the dangerous direction. States are derived deterministically: `insufficient-data` (< `minPopulation` observations on either side), `drifting` (z ≥ 2.0), `watching` (z ≥ 1.0), else `stable`.
- **Policy** (`src/policy.ts`), in precedence order: active drift denies outright (fail-safe); a watching signal holds at require-approval; a score ≥ `trustedMin` (0.75) with confidence ≥ `minConfidence` (0.6) allows; anything ≥ `reviewMin` (0.45) requires approval; below that is denied. Low confidence caps an otherwise-trusted agent at require-approval — evidence that is too thin never auto-approves.
- **Audit** (`src/audit.ts`): each entry stores `seq`, `prevHash`, timestamp, kind and data, with `hash = SHA-256(prevHash|at|kind|data)`. On reload the chain is re-verified; a broken middle entry throws `CorruptionError`, while a single unparseable *final* line (a crash mid-append) is tolerated.

## Getting started

Requires Node >= 20 (or Bun >= 1.2).

```bash
npm install github:Retsumdk/agent-trust-calibration
```

> **Bun users:** Bun blocks lifecycle scripts of git dependencies by default, so the `prepare` build would not run. After installing, run `bun pm trust agent-trust-calibration` once, or use the npm path which runs it automatically.

Or clone and build:

```bash
git clone https://github.com/Retsumdk/agent-trust-calibration.git
cd agent-trust-calibration
bun install
bun run build
```

## Library example

```typescript
import { TrustRegistry } from "agent-trust-calibration";

const registry = new TrustRegistry();

registry.registerAgent("scout-1");
for (let i = 0; i < 20; i++) {
  registry.recordOutcome("scout-1", { taskId: `t${i}`, kind: "success" });
}
registry.recordOutcome("scout-1", { taskId: "t20", kind: "failure" });

console.log(registry.score("scout-1"));
// { agentId: 'scout-1', score: 0.9523809523809523, confidence: 0.8076923076923077, ... }

console.log(registry.decide("scout-1"));
// { decision: 'require-approval', tier: 'trusted',
//   reasons: [ 'early drift signal (z=1.05) — holding at approval' ], ... }
```

## CLI

The package ships a `agent-trust-calibration` bin (also runnable via `npx github:Retsumdk/agent-trust-calibration`). State persists to `--state` (JSON) and mutations append to `--audit` (hash-chained JSONL).

```console
$ agent-trust-calibration register scout --state trust-state.json
registered scout

$ agent-trust-calibration record scout --task t1 --kind success --state trust-state.json
recorded success (quality 1) for scout on t1
REQUIRE-APPROVAL (provisional) — confidence 0.17 below floor 0.60 — evidence too thin to auto-approve

$ agent-trust-calibration score scout --state trust-state.json
scout: score 1 confidence 0.1667 ±0.002 (N_eff 1 of 1 observations)

$ agent-trust-calibration audit --audit trust-audit.jsonl
entries 2  intact true  head eaa138c0ef915921968920f2548a878f4000f6ddc8a4bbae1f899027c612e396
  #0 agent.registered
  #1 outcome.recorded
```

One observation is never enough to auto-approve: the policy says so out loud. Failing a task flips the recommendation immediately:

```console
$ agent-trust-calibration record scout --task t2 --kind failure --state trust-state.json
recorded failure (quality 0) for scout on t2
REQUIRE-APPROVAL (provisional) — confidence 0.29 below floor 0.60 — evidence too thin to auto-approve
```

Commands: `register`, `record`, `score`, `drift`, `decide`, `agents`, `policy`, `calibration`, `audit`, `serve`, `demo`, `help`. Exit codes: `0` success, `1` validation/not-found, `2` usage error.

## Demo

`bun src/cli.ts demo` (or `node dist/cli.js demo`) walks three archetypes — a steady performer, a degrading agent, and a cold-start agent — with a fixed clock, so the output is byte-identical on every machine:

```
== agents ==
atlas-9  score 1      confidence 0.8497 drift stable             allow (trusted)
novus-2  score 1      confidence 0.3749 drift insufficient-data  require-approval (provisional)
scout-1  score 0.5953 confidence 0.8567 drift drifting           deny (provisional)

== scout-1 drift ==
state drifting  z=8.9555  baseline 0.9318 vs recent 0.15 (22 vs 10)

== decisions ==
atlas-9  ALLOW (trusted) — score 1.000 >= trusted floor 0.75 with confidence 0.85
scout-1  DENY (provisional) — active drift detected (z=8.96) — fail-safe deny
novus-2  REQUIRE-APPROVAL (provisional) — confidence 0.37 below floor 0.60 — evidence too thin to auto-approve
```

`scout-1` produced 22 strong outcomes and then collapsed (mixed partials and failures in its most recent 10 tasks). Its recency-weighted score is still 0.60 — a lifetime average would be far more forgiving — but the drift test sees the collapse (z = 8.96) and the policy denies. This is exactly the failure mode static trust misses.

## HTTP server

`agent-trust-calibration serve --port 8619 --token <secret>` exposes the registry over HTTP. Reads are open; writes require `Authorization: Bearer <token>` (constant-time comparison). A server started without a token rejects all writes with 401 — an unauthenticated write path is never shipped by accident.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness + agent count |
| GET | `/agents` | All agent summaries (score, confidence, drift, decision, tier) |
| POST | `/agents` | Register an agent `{ "id": "..." }` — auth |
| GET | `/agents/:id` | Full detail: score + drift + decision |
| GET | `/agents/:id/drift` | Drift report only |
| POST | `/outcomes` | Record `{ "agentId", "taskId", "kind", "quality?", "at?" }` — auth |
| POST | `/policy` | Update thresholds `{ "trustedMin?", "reviewMin?", "minConfidence?" }` — auth |
| POST | `/calibration` | Update calibration `{ "halfLifeMs?", "windowSize?", ... }` — auth |
| GET | `/audit` | Ledger report + last 20 entries |

Errors come back as `{ "error": "...", "code": "VALIDATION|NOT_FOUND|CONFLICT|UNAUTHORIZED|CORRUPTION|CONFIG" }` with matching HTTP status (400/404/409/401/500).

## Calibration knobs

| Option | Default | Meaning |
|--------|---------|---------|
| `halfLifeMs` | 7 days | Age at which an observation's weight halves |
| `windowSize` | 10 | Recent-window size for drift detection |
| `minPopulation` | 5 | Minimum observations on each side of the drift test |
| `breachThreshold` | 2.0 | z at which an agent is `drifting` |
| `watchThreshold` | 1.0 | z at which an agent is `watching` |
| `trustedMin` | 0.75 | Score floor for `trusted` / `allow` |
| `reviewMin` | 0.45 | Score floor between deny and require-approval |
| `minConfidence` | 0.6 | Confidence floor for auto-approval |

## Project layout

```
src/
├── types.ts         domain types (outcomes, scores, drift, policy)
├── errors.ts        TrustError hierarchy with stable codes
├── hashing.ts       SHA-256, constant-time comparison
├── scoring.ts       recency-weighted score + confidence
├── drift.ts         two-population drift z-test
├── policy.ts        threshold policy with reasons
├── registry.ts      TrustRegistry (agents, outcomes, persistence)
├── persistence.ts   atomic JSON writes
├── audit.ts         hash-chained append-only ledger
├── config.ts        calibration validation
├── server.ts        HTTP surface
├── cli.ts           command-line interface
└── demo.ts          deterministic walkthrough
tests/               40 tests (bun test) over 5 suites
```

## Related repos

- [agent-collision-detector](https://github.com/Retsumdk/agent-collision-detector) — detect and resolve conflicts between autonomous agents
- [agent-reputational-graph](https://github.com/Retsumdk/agent-reputational-graph) — agent-to-agent reputation across a mesh
- [agent-logic-fuzzer](https://github.com/Retsumdk/agent-logic-fuzzer) — property-based stress testing for agent decision loops

## License

[MIT](LICENSE) © Retsumdk
