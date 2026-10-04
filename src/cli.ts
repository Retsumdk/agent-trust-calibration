#!/usr/bin/env node
/**
 * agent-trust-calibration CLI
 *
 * Commands: register, record, score, drift, decide, agents, policy,
 * calibration, audit, serve, demo. State is persisted to --state (JSON) and
 * every mutation is appended to --audit (hash-chained JSONL) when given.
 */

import { parseArgs } from "node:util";
import { TrustError } from "./errors.js";
import { round4 } from "./hashing.js";
import { describeDecision } from "./policy.js";
import { TrustRegistry } from "./registry.js";
import { listenTrustServer } from "./server.js";
import { runDemo } from "./demo.js";

interface Parsed {
  values: Record<string, string | string[] | boolean | undefined>;
  positionals: string[];
}

function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      state: { type: "string" },
      audit: { type: "string" },
      token: { type: "string" },
      port: { type: "string", default: "8619" },
      task: { type: "string" },
      kind: { type: "string" },
      quality: { type: "string" },
      at: { type: "string" },
      "trusted-min": { type: "string" },
      "review-min": { type: "string" },
      "min-confidence": { type: "string" },
      "half-life-hours": { type: "string" },
      "window-size": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  return { values: values as Record<string, string | string[] | boolean | undefined>, positionals };
}

function numberOption(source: Record<string, unknown>, key: string, label: string): number | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TrustError("VALIDATION", `--${key} must be a number (got ${String(raw)}) for ${label}`);
  }
  return value;
}

function buildRegistry(parsed: Parsed): TrustRegistry {
  const values = parsed.values;
  const halfLifeHours = numberOption(values, "half-life-hours", "calibration");
  const windowSize = numberOption(values, "window-size", "calibration");
  return new TrustRegistry({
    statePath: typeof values["state"] === "string" ? values["state"] : undefined,
    auditPath: typeof values["audit"] === "string" ? values["audit"] : undefined,
    options: {
      ...(halfLifeHours !== undefined ? { halfLifeMs: halfLifeHours * 3_600_000 } : {}),
      ...(windowSize !== undefined ? { windowSize } : {}),
    },
  });
}

function thresholdPatch(values: Record<string, unknown>): Record<string, number> {
  const patch: Record<string, number> = {};
  const trustedMin = numberOption(values, "trusted-min", "policy");
  const reviewMin = numberOption(values, "review-min", "policy");
  const minConfidence = numberOption(values, "min-confidence", "policy");
  if (trustedMin !== undefined) patch["trustedMin"] = trustedMin;
  if (reviewMin !== undefined) patch["reviewMin"] = reviewMin;
  if (minConfidence !== undefined) patch["minConfidence"] = minConfidence;
  return patch;
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }

  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    usage();
    return 2;
  }

  const [command, ...rest] = parsed.positionals;
  try {
    switch (command) {
      case "demo": {
        process.stdout.write(runDemo());
        return 0;
      }
      case "help":
      case undefined: {
        usage();
        return 0;
      }
      case "register": {
        const id = rest[0];
        if (id === undefined) throw new TrustError("VALIDATION", "usage: register <agent-id>");
        const registry = buildRegistry(parsed);
        const profile = registry.registerAgent(id);
        process.stdout.write(`registered ${profile.id}\n`);
        return 0;
      }
      case "record": {
        const agentId = rest[0];
        if (agentId === undefined) {
          throw new TrustError("VALIDATION", "usage: record <agent-id> --task <id> --kind success|partial|failure [--quality n] [--at epoch-ms]");
        }
        const values = parsed.values;
        const registry = buildRegistry(parsed);
        const record = registry.recordOutcome(agentId, {
          taskId: typeof values["task"] === "string" ? values["task"] : "",
          kind: (typeof values["kind"] === "string" ? values["kind"] : "") as never,
          quality: numberOption(values, "quality", "record"),
          at: numberOption(values, "at", "record"),
        });
        const decision = registry.decide(agentId);
        process.stdout.write(
          `recorded ${record.kind} (quality ${record.quality}) for ${agentId} on ${record.taskId}\n` +
            `${describeDecision(decision)}\n`,
        );
        return 0;
      }
      case "score": {
        const agentId = rest[0];
        if (agentId === undefined) throw new TrustError("VALIDATION", "usage: score <agent-id>");
        const registry = buildRegistry(parsed);
        const score = registry.score(agentId);
        process.stdout.write(
          `${agentId}: score ${round4(score.score)} confidence ${round4(score.confidence)} ` +
            `±${round4(score.margin)} (N_eff ${round4(score.effectiveSamples)} of ${score.observations} observations)\n`,
        );
        return 0;
      }
      case "drift": {
        const agentId = rest[0];
        if (agentId === undefined) throw new TrustError("VALIDATION", "usage: drift <agent-id>");
        const registry = buildRegistry(parsed);
        const report = registry.drift(agentId);
        process.stdout.write(
          `${agentId}: ${report.state}` +
            (report.zScore === null ? "" : ` (z=${round4(report.zScore)})`) +
            ` baseline ${report.baselineMean === null ? "n/a" : round4(report.baselineMean)} vs recent ` +
            `${report.recentMean === null ? "n/a" : round4(report.recentMean)}\n`,
        );
        return 0;
      }
      case "decide": {
        const agentId = rest[0];
        if (agentId === undefined) throw new TrustError("VALIDATION", "usage: decide <agent-id>");
        const registry = buildRegistry(parsed);
        process.stdout.write(`${describeDecision(registry.decide(agentId))}\n`);
        return 0;
      }
      case "agents": {
        const registry = buildRegistry(parsed);
        const agents = registry.listAgents();
        if (agents.length === 0) {
          process.stdout.write("no agents registered\n");
          return 0;
        }
        for (const agent of agents) {
          process.stdout.write(
            `${agent.id}  score ${agent.score}  confidence ${agent.confidence}  ` +
              `drift ${agent.drift}  ${agent.decision} (${agent.tier})  ${agent.observations} obs\n`,
          );
        }
        return 0;
      }
      case "policy": {
        const registry = buildRegistry(parsed);
        const patch = thresholdPatch(parsed.values);
        const thresholds = Object.keys(patch).length > 0 ? registry.updateThresholds(patch) : registry.thresholds;
        process.stdout.write(
          `trustedMin ${thresholds.trustedMin}  reviewMin ${thresholds.reviewMin}  minConfidence ${thresholds.minConfidence}\n`,
        );
        return 0;
      }
      case "calibration": {
        const registry = buildRegistry(parsed);
        const calibration = registry.calibration;
        process.stdout.write(
          `halfLifeMs ${calibration.halfLifeMs}  windowSize ${calibration.windowSize}  ` +
            `minPopulation ${calibration.minPopulation}  breachThreshold ${calibration.breachThreshold}  ` +
            `watchThreshold ${calibration.watchThreshold}\n`,
        );
        return 0;
      }
      case "audit": {
        const registry = buildRegistry(parsed);
        const log = registry.auditLog;
        if (log === undefined) throw new TrustError("CONFIG", "no --audit path given");
        const report = log.report();
        process.stdout.write(
          `entries ${report.entries}  intact ${report.intact}  head ${report.headHash}\n`,
        );
        for (const entry of log.tail(10)) {
          process.stdout.write(`  #${entry.seq} ${entry.kind}\n`);
        }
        return 0;
      }
      case "serve": {
        const registry = buildRegistry(parsed);
        const port = numberOption(parsed.values, "port", "serve") ?? 8619;
        const token = typeof parsed.values["token"] === "string" ? parsed.values["token"] : undefined;
        const handle = await listenTrustServer(registry, port, { token });
        process.stdout.write(`listening on http://127.0.0.1:${handle.port}\n`);
        await new Promise<void>(() => {});
        return 0;
      }
      default:
        process.stderr.write(`error: unknown command "${command ?? ""}"\n`);
        usage();
        return 2;
    }
  } catch (error) {
    if (error instanceof TrustError) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function usage(): void {
  process.stdout.write(
    [
      "agent-trust-calibration — dynamic trust calibration for autonomous agents",
      "",
      "Usage:",
      "  trust-calibration register <agent-id>",
      "  trust-calibration record <agent-id> --task <id> --kind success|partial|failure [--quality n] [--at epoch-ms]",
      "  trust-calibration score <agent-id>",
      "  trust-calibration drift <agent-id>",
      "  trust-calibration decide <agent-id>",
      "  trust-calibration agents",
      "  trust-calibration policy [--trusted-min n] [--review-min n] [--min-confidence n]",
      "  trust-calibration calibration",
      "  trust-calibration audit",
      "  trust-calibration serve [--port n] [--token secret]",
      "  trust-calibration demo",
      "",
      "Options:",
      "  --state <file>          persist registry state to a JSON file",
      "  --audit <file>          append every mutation to a hash-chained JSONL ledger",
      "  --half-life-hours n     score half-life (default 168 = 7 days)",
      "  --window-size n         drift detection recent window (default 10)",
      "",
    ].join("\n"),
  );
}

if (process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts")) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
