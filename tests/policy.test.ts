import { describe, expect, test } from "bun:test";
import { TrustPolicy } from "../src/policy.js";
import type { DriftReport, TrustScore } from "../src/types.js";

const score = (overrides: Partial<TrustScore> = {}): TrustScore => ({
  agentId: "a",
  score: 0.9,
  confidence: 0.9,
  margin: 0.05,
  effectiveSamples: 20,
  observations: 20,
  lastOutcomeAt: 0,
  computedAt: 0,
  ...overrides,
});

const drift = (state: DriftReport["state"], zScore: number | null = null): DriftReport => ({
  agentId: "a",
  state,
  baselineMean: 1,
  recentMean: 0.9,
  zScore,
  baselineSize: 20,
  recentSize: 10,
  evaluatedAt: 0,
});

describe("TrustPolicy", () => {
  test("high score with high confidence allows", () => {
    const decision = new TrustPolicy().evaluate("a", score(), drift("stable"));
    expect(decision.decision).toBe("allow");
    expect(decision.tier).toBe("trusted");
  });

  test("low confidence caps an otherwise-trusted agent at approval", () => {
    const decision = new TrustPolicy().evaluate("a", score({ confidence: 0.3 }), drift("stable"));
    expect(decision.decision).toBe("require-approval");
    expect(decision.reasons.some((r) => r.includes("confidence"))).toBe(true);
  });

  test("mid-band scores require approval", () => {
    const decision = new TrustPolicy().evaluate("a", score({ score: 0.6, confidence: 0.9 }), drift("stable"));
    expect(decision.decision).toBe("require-approval");
    expect(decision.tier).toBe("provisional");
  });

  test("scores under the review floor are denied", () => {
    const decision = new TrustPolicy().evaluate("a", score({ score: 0.2 }), drift("stable"));
    expect(decision.decision).toBe("deny");
    expect(decision.tier).toBe("restricted");
  });

  test("active drift denies regardless of score", () => {
    const decision = new TrustPolicy().evaluate("a", score(), drift("drifting", 3.1));
    expect(decision.decision).toBe("deny");
    expect(decision.reasons[0]).toContain("active drift");
  });

  test("watching holds at approval", () => {
    const decision = new TrustPolicy().evaluate("a", score(), drift("watching", 1.2));
    expect(decision.decision).toBe("require-approval");
  });

  test("cold start notes the missing evidence", () => {
    const decision = new TrustPolicy().evaluate("a", score({ observations: 0, confidence: 0 }), drift("insufficient-data"));
    expect(decision.decision).toBe("require-approval");
    expect(decision.reasons).toContain("no observations on record — cold start defaults apply");
  });

  test("threshold updates validate their ranges", () => {
    const policy = new TrustPolicy();
    policy.update({ trustedMin: 0.5 });
    expect(policy.config.trustedMin).toBe(0.5);
    expect(() => policy.update({ trustedMin: 1.5 })).toThrow(TypeError);
    expect(() => policy.update({ reviewMin: -0.1 })).toThrow(TypeError);
    expect(() => policy.update({ trustedMin: 0.3, reviewMin: 0.4 })).toThrow(/>= reviewMin/);
  });

  test("returned decisions carry the evidence snapshot", () => {
    const decision = new TrustPolicy().evaluate("a", score({ score: 0.82 }), drift("stable", 0.2));
    expect(decision.score).toBe(0.82);
    expect(decision.drift).toBe("stable");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
