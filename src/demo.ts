import { TrustRegistry } from "./registry.js";
import { describeDecision } from "./policy.js";
import { round4 } from "./hashing.js";

const HOUR = 3_600_000;

/**
 * Deterministic walkthrough: fixed clock, fixed outcome stream. The output is
 * byte-identical across runs and machines, so it can be embedded in the README
 * and asserted in tests. It walks three archetypes — a steady performer, a
 * degrading agent caught by drift detection, and a cold-start agent held at
 * approval by low confidence.
 */
export function runDemo(): string {
  const lines: string[] = [];
  const start = 1_700_000_000_000;
  let tick = 0;
  const clock = () => start + tick * HOUR;

  const registry = new TrustRegistry({
    clock,
    options: { halfLifeMs: 24 * HOUR, windowSize: 10, minPopulation: 5 },
    thresholds: { trustedMin: 0.75, reviewMin: 0.45, minConfidence: 0.6 },
  });

  const emit = (line: string): void => {
    lines.push(line);
  };

  for (const id of ["atlas-9", "scout-1", "novus-2"]) registry.registerAgent(id);

  for (let i = 0; i < 30; i++) {
    tick = i;
    registry.recordOutcome("atlas-9", { taskId: `t${i}`, kind: "success", at: clock() });
  }

  for (let i = 0; i < 20; i++) {
    tick = i;
    registry.recordOutcome("scout-1", { taskId: `t${i}`, kind: "success", at: clock() });
  }
  for (let i = 20; i < 32; i++) {
    tick = i;
    registry.recordOutcome("scout-1", { taskId: `t${i}`, kind: i % 3 === 0 ? "partial" : "failure", at: clock() });
  }

  for (let i = 0; i < 3; i++) {
    tick = i;
    registry.recordOutcome("novus-2", { taskId: `t${i}`, kind: "success", at: clock() });
  }

  tick = 40;
  emit("== agents ==");
  for (const agent of registry.listAgents()) {
    emit(
      `${agent.id.padEnd(8)} score ${String(agent.score).padEnd(6)} confidence ${String(agent.confidence).padEnd(6)} ` +
        `drift ${agent.drift.padEnd(18)} ${agent.decision} (${agent.tier})`,
    );
  }

  emit("");
  emit("== scout-1 drift ==");
  const drift = registry.drift("scout-1");
  emit(
    `state ${drift.state}  z=${drift.zScore === null ? "n/a" : round4(drift.zScore)}  ` +
      `baseline ${drift.baselineMean === null ? "n/a" : round4(drift.baselineMean)} vs recent ` +
      `${drift.recentMean === null ? "n/a" : round4(drift.recentMean)} (${drift.baselineSize} vs ${drift.recentSize})`,
  );

  emit("");
  emit("== decisions ==");
  for (const id of ["atlas-9", "scout-1", "novus-2"]) {
    emit(`${id.padEnd(8)} ${describeDecision(registry.decide(id))}`);
  }

  const log = registry.auditLog;
  if (log !== undefined) {
    const report = log.report();
    emit("");
    emit("== audit ==");
    emit(`entries ${report.entries}  intact ${report.intact}  head ${report.headHash.slice(0, 16)}…`);
  }

  return lines.join("\n") + "\n";
}
