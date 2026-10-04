import { describe, expect, test } from "bun:test";
import { evaluateDrift } from "../src/drift.js";
import { DEFAULT_OPTIONS } from "../src/registry.js";
import type { OutcomeRecord } from "../src/types.js";

const build = (baseline: number[], recent: number[]): OutcomeRecord[] => [
  ...baseline.map((quality, i) => ({ taskId: `b${i}`, kind: "success", quality, at: i })),
  ...recent.map((quality, i) => ({ taskId: `r${i}`, kind: "success", quality, at: 1000 + i })),
];

describe("evaluateDrift", () => {
  test("too little data is insufficient", () => {
    const options = { ...DEFAULT_OPTIONS, windowSize: 2, minPopulation: 3 };
    const report = evaluateDrift("a", build([1, 1, 1], [0, 0]), 10, options);
    expect(report.state).toBe("insufficient-data");
    expect(report.zScore).toBeNull();
    expect(report.baselineSize).toBe(3);
    expect(report.recentSize).toBe(2);
  });

  test("a clean collapse is detected as drifting", () => {
    const report = evaluateDrift("a", build(Array(20).fill(1), Array(10).fill(0)), 100, DEFAULT_OPTIONS);
    expect(report.state).toBe("drifting");
    expect(report.baselineMean).toBe(1);
    expect(report.recentMean).toBe(0);
    expect(report.zScore!).toBeGreaterThan(2);
  });

  test("a mild dip lands in watching", () => {
    // Noisy baseline (mean 0.9, variance 0.01) and a noisy recent window
    // (mean 0.75, variance 0.0625): z = 0.15 / sqrt(0.01/20 + 0.0625/10) ≈ 1.83
    // — past the watch line, under the breach line.
    const baseline = [...Array(10).fill(1), ...Array(10).fill(0.8)];
    const recent = [...Array(5).fill(1), ...Array(5).fill(0.5)];
    const report = evaluateDrift("a", build(baseline, recent), 100, DEFAULT_OPTIONS);
    expect(report.state).toBe("watching");
    expect(report.zScore!).toBeGreaterThanOrEqual(1);
    expect(report.zScore!).toBeLessThan(2);
  });

  test("stable history stays stable", () => {
    const report = evaluateDrift("a", build(Array(30).fill(0.9), Array(10).fill(0.9)), 100, DEFAULT_OPTIONS);
    expect(report.state).toBe("stable");
  });

  test("improvement is not drift", () => {
    const report = evaluateDrift("a", build(Array(20).fill(0.2), Array(10).fill(1)), 100, DEFAULT_OPTIONS);
    expect(report.zScore!).toBeLessThan(0);
    expect(report.state).toBe("stable");
  });

  test("window and population sizes follow the calibration options", () => {
    const options = { ...DEFAULT_OPTIONS, windowSize: 3, minPopulation: 2 };
    const report = evaluateDrift("a", build(Array(6).fill(1), Array(3).fill(0)), 100, options);
    expect(report.recentSize).toBe(3);
    expect(report.baselineSize).toBe(6);
    expect(report.state).toBe("drifting");
  });

  test("zero variance with a real difference still trips the breach", () => {
    const report = evaluateDrift("a", build(Array(20).fill(1), Array(10).fill(0.4)), 100, DEFAULT_OPTIONS);
    expect(report.state).toBe("drifting");
  });

  test("evaluatedAt carries the clock", () => {
    const report = evaluateDrift("a", build(Array(20).fill(1), Array(10).fill(1)), 4242, DEFAULT_OPTIONS);
    expect(report.evaluatedAt).toBe(4242);
  });
});
