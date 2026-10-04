import type { CalibrationOptions, DriftReport, OutcomeRecord } from "./types.js";

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function populationVariance(values: readonly number[], mu: number): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + (v - mu) * (v - mu), 0) / values.length;
}

/**
 * Two-population drift test. The agent's outcome history is split into a
 * baseline (everything before the most recent `windowSize` observations) and a
 * recent window. A z-statistic compares the two quality means, using pooled
 * standard error `sqrt(varB/nB + varR/nR)` (population variances — small,
 * bounded samples). Negative z means the agent improved; positive z means the
 * recent window is performing worse than its own history, which is the
 * dangerous direction for an agent holding live permissions.
 *
 * States, deterministically derived (no hidden memory):
 * - `insufficient-data` — fewer than `minPopulation` observations on either side
 * - `drifting` — z >= breachThreshold (default 2.0)
 * - `watching` — z >= watchThreshold (default 1.0)
 * - `stable` — otherwise
 */
export function evaluateDrift(
  agentId: string,
  outcomes: readonly OutcomeRecord[],
  now: number,
  options: CalibrationOptions,
): DriftReport {
  const { windowSize, minPopulation, breachThreshold, watchThreshold } = options;
  const cut = Math.max(0, outcomes.length - Math.floor(windowSize));
  const baseline = outcomes.slice(0, cut);
  const recent = outcomes.slice(cut);

  const baselineMean = mean(baseline.map((o) => o.quality));
  const recentMean = mean(recent.map((o) => o.quality));

  const base: Omit<DriftReport, "state" | "zScore"> = {
    agentId,
    baselineMean: baseline.length > 0 ? baselineMean : null,
    recentMean: recent.length > 0 ? recentMean : null,
    baselineSize: baseline.length,
    recentSize: recent.length,
    evaluatedAt: now,
  };

  if (baseline.length < minPopulation || recent.length < minPopulation) {
    return { ...base, state: "insufficient-data", zScore: null };
  }

  const varBaseline = populationVariance(baseline.map((o) => o.quality), baselineMean);
  const varRecent = populationVariance(recent.map((o) => o.quality), recentMean);
  const standardError = Math.sqrt(varBaseline / baseline.length + varRecent / recent.length);
  const diff = baselineMean - recentMean;

  let z: number;
  if (standardError === 0) {
    z = diff === 0 ? 0 : 999 * Math.sign(diff);
  } else {
    z = diff / standardError;
  }

  const state: DriftReport["state"] =
    z >= breachThreshold ? "drifting" : z >= watchThreshold ? "watching" : "stable";

  return { ...base, state, zScore: z };
}
