import { describe, expect, test } from "bun:test";
import { computeScore } from "../src/scoring.js";
import type { OutcomeRecord } from "../src/types.js";

const HOUR = 3_600_000;

const outcomes = (qualities: number[], atStep = 0): OutcomeRecord[] =>
  qualities.map((quality, i) => ({
    taskId: `t${i + atStep}`,
    kind: quality >= 1 ? "success" : quality <= 0 ? "failure" : "partial",
    quality,
    at: (atStep + i) * HOUR,
  }));

describe("computeScore", () => {
  test("perfect recent history scores 1 with rising confidence", () => {
    const few = computeScore("a", outcomes(Array(6).fill(1)), 6 * HOUR, 24 * HOUR);
    const many = computeScore("a", outcomes(Array(60).fill(1)), 60 * HOUR, 24 * HOUR);
    expect(few.score).toBe(1);
    expect(many.score).toBe(1);
    expect(many.confidence).toBeGreaterThan(few.confidence);
    expect(many.confidence).toBeLessThan(1);
  });

  test("an empty record cold-starts at 0.5 with zero confidence", () => {
    const score = computeScore("a", [], 0, 24 * HOUR);
    expect(score.score).toBe(0.5);
    expect(score.confidence).toBe(0);
    expect(score.effectiveSamples).toBe(0);
    expect(score.margin).toBe(0.5);
    expect(score.lastOutcomeAt).toBeNull();
  });

  test("recency weighting pulls the score toward recent outcomes", () => {
    // Same multiset of qualities, opposite ordering: only recency weighting can
    // make these scores differ. With a 50/50 mix, whichever half is recent
    // decides which side of 0.5 the score lands on.
    const recentFailures = computeScore("a", [...outcomes(Array(10).fill(1)), ...outcomes(Array(10).fill(0), 10)], 20 * HOUR, 24 * HOUR);
    const recentSuccesses = computeScore("a", [...outcomes(Array(10).fill(0)), ...outcomes(Array(10).fill(1), 10)], 20 * HOUR, 24 * HOUR);
    expect(recentSuccesses.score).toBeGreaterThan(recentFailures.score);
    expect(recentFailures.score).toBeLessThan(0.5);
    expect(recentSuccesses.score).toBeGreaterThan(0.5);
  });

  test("old failures decay toward irrelevance", () => {
    const history = outcomes(Array(4).fill(0));
    history.push(...outcomes(Array(16).fill(1), 4));
    const fresh = computeScore("a", history, 20 * HOUR, 24 * HOUR);
    const muchLater = computeScore("a", history, 20 * HOUR + 60 * 24 * HOUR, 24 * HOUR);
    expect(muchLater.score).toBeGreaterThan(fresh.score);
  });

  test("margin shrinks as evidence accumulates", () => {
    const few = computeScore("a", outcomes([1, 0, 1, 0, 1]), 5 * HOUR, 24 * HOUR);
    const many = computeScore("a", outcomes([...Array(50).fill(1), ...Array(50).fill(0)]), 100 * HOUR, 24 * HOUR);
    expect(many.margin).toBeLessThan(few.margin);
  });

  test("mixed history lands near its mean", () => {
    const score = computeScore("a", outcomes(Array(30).fill(0.7)), 30 * HOUR, 24 * HOUR);
    expect(score.score).toBeCloseTo(0.7, 5);
  });

  test("never negative or above one", () => {
    const score = computeScore("a", outcomes([1, 0, 0.3, 1, 0]), 5 * HOUR, 3.6e6);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(1);
  });
});
