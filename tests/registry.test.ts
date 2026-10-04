import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustRegistry } from "../src/registry.js";

const HOUR = 3_600_000;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trust-"));
}

describe("TrustRegistry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("register, record and score end to end", () => {
    let tick = 0;
    const registry = new TrustRegistry({ clock: () => tick * HOUR });
    registry.registerAgent("atlas");
    for (let i = 0; i < 30; i++) {
      tick = i;
      registry.recordOutcome("atlas", { taskId: `t${i}`, kind: "success" });
    }
    tick = 30;
    const score = registry.score("atlas");
    expect(score.score).toBe(1);
    expect(score.observations).toBe(30);
    expect(score.confidence).toBeGreaterThan(0.85);
    expect(score.lastOutcomeAt).toBe(29 * HOUR);
  });

  test("quality defaults follow the outcome kind", () => {
    let tick = 0;
    const registry = new TrustRegistry({ clock: () => tick++ * HOUR });
    registry.registerAgent("a");
    const success = registry.recordOutcome("a", { taskId: "s", kind: "success" });
    const partial = registry.recordOutcome("a", { taskId: "p", kind: "partial" });
    const failure = registry.recordOutcome("a", { taskId: "f", kind: "failure" });
    expect(success.quality).toBe(1);
    expect(partial.quality).toBe(0.5);
    expect(failure.quality).toBe(0);
  });

  test("explicit quality and timestamps are honored", () => {
    const registry = new TrustRegistry({ clock: () => 1000 });
    registry.registerAgent("a");
    const record = registry.recordOutcome("a", { taskId: "t", kind: "partial", quality: 0.8, at: 500 });
    expect(record.quality).toBe(0.8);
    expect(record.at).toBe(500);
  });

  test("validation rejects bad inputs", () => {
    const registry = new TrustRegistry();
    expect(() => registry.registerAgent("   ")).toThrow(/non-empty/);
    expect(() => registry.registerAgent("x".repeat(129))).toThrow(/128/);
    registry.registerAgent("a");
    expect(() => registry.registerAgent("a")).toThrow(/already registered/);
    expect(() => registry.recordOutcome("ghost", { taskId: "t", kind: "success" })).toThrow(/not registered/);
    expect(() => registry.recordOutcome("a", { taskId: "  ", kind: "success" })).toThrow(/taskId/);
    expect(() => registry.recordOutcome("a", { taskId: "t", kind: "catastrophe" as never })).toThrow(/kind/);
    expect(() => registry.recordOutcome("a", { taskId: "t", kind: "success", quality: 1.5 })).toThrow(/\[0, 1\]/);
    expect(() => registry.recordOutcome("a", { taskId: "t", kind: "success", at: -5 })).toThrow(/non-negative/);
    expect(() => registry.score("ghost")).toThrow(/not registered/);
  });

  test("decisions reflect recorded reality", () => {
    let tick = 0;
    const registry = new TrustRegistry({ clock: () => tick++ * HOUR, thresholds: { minConfidence: 0.6 } });
    registry.registerAgent("solid");
    for (let i = 0; i < 25; i++) registry.recordOutcome("solid", { taskId: `t${i}`, kind: "success" });
    expect(registry.decide("solid").decision).toBe("allow");

    registry.registerAgent("rookie");
    registry.recordOutcome("rookie", { taskId: "t0", kind: "success" });
    expect(registry.decide("rookie").decision).toBe("require-approval");

    registry.registerAgent("bad");
    for (let i = 0; i < 20; i++) registry.recordOutcome("bad", { taskId: `t${i}`, kind: "failure" });
    expect(registry.decide("bad").decision).toBe("deny");
  });

  test("listAgents is sorted and complete", () => {
    const registry = new TrustRegistry({ clock: () => 0 });
    registry.registerAgent("zeta");
    registry.registerAgent("alpha");
    const list = registry.listAgents();
    expect(list.map((a) => a.id)).toEqual(["alpha", "zeta"]);
    expect(list[0]!.observations).toBe(0);
  });

  test("state persists and reloads with the full ledger", () => {
    const dir = tempDir();
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const auditPath = join(dir, "audit.jsonl");

    let tick = 0;
    const first = new TrustRegistry({ clock: () => tick++ * HOUR, statePath, auditPath });
    first.registerAgent("atlas");
    for (let i = 0; i < 12; i++) first.recordOutcome("atlas", { taskId: `t${i}`, kind: "success" });
    first.updateThresholds({ trustedMin: 0.8 });

    const second = new TrustRegistry({ clock: () => 12 * HOUR, statePath, auditPath });
    expect(second.has("atlas")).toBe(true);
    expect(second.score("atlas").observations).toBe(12);
    expect(second.thresholds.trustedMin).toBe(0.8);
    expect(second.auditLog?.report().entries).toBe(14);
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(auditPath)).toBe(true);
  });

  test("a corrupted state file fails loudly", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const first = new TrustRegistry({ clock: () => 0, statePath });
    first.registerAgent("a");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as { agents: unknown[] };
    (raw as { options: unknown }).options = { halfLifeMs: -1 };
    (raw as { agents: unknown }).agents = raw.agents;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(statePath, JSON.stringify(raw));
    expect(() => new TrustRegistry({ clock: () => 0, statePath })).toThrow(/invalid calibration data/);
  });

  test("recalibrate changes drift sensitivity", () => {
    const registry = new TrustRegistry({ clock: () => 0 });
    registry.recalibrate({ windowSize: 4, breachThreshold: 3 });
    expect(registry.calibration.windowSize).toBe(4);
    expect(registry.calibration.breachThreshold).toBe(3);
    expect(() => registry.recalibrate({ windowSize: 0 })).toThrow(TypeError);
  });

  test("audit ledger records the mutation stream", () => {
    const dir = tempDir();
    dirs.push(dir);
    const registry = new TrustRegistry({ clock: () => 0, auditPath: join(dir, "a.jsonl") });
    registry.registerAgent("a");
    registry.recordOutcome("a", { taskId: "t", kind: "success" });
    registry.updateThresholds({ reviewMin: 0.5 });
    const log = registry.auditLog!;
    expect(log.size).toBe(3);
    expect(log.tail(3).map((e) => e.kind)).toEqual(["agent.registered", "outcome.recorded", "policy.updated"]);
    expect(log.report().intact).toBe(true);
  });
});
