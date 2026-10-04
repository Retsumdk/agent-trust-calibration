import type { OutcomeKind, OutcomeRecord, TrustScore } from "./types.js";

const DEFAULT_QUALITY: Record<OutcomeKind, number> = { success: 1, partial: 0.5, failure: 0 };

export const defaultQuality = (kind: OutcomeKind): number => DEFAULT_QUALITY[kind];

export const CONFIDENCE_HALF_SATURATION = 5;

/**
 * Recency-weighted trust score. Every observation contributes its outcome
 * quality weighted by exponential decay: an observation `age` ms old weighs
 * `0.5 ** (age / halfLifeMs)`. The score is the weighted mean quality;
 * confidence rises with the effective sample size (Kish formula) and saturates
 * at `N_eff / (N_eff + 5)`; margin is the 95% half-width of a normal
 * approximation around the weighted mean, clamped to [0, 0.5].
 */
export function computeScore(
  agentId: string,
  outcomes: readonly OutcomeRecord[],
  now: number,
  halfLifeMs: number,
): TrustScore {
  let weightSum = 0;
  let weightedQuality = 0;
  let weightSquaredSum = 0;
  let lastOutcomeAt: number | null = null;

  for (const outcome of outcomes) {
    const age = Math.max(0, now - outcome.at);
    const weight = Math.pow(0.5, age / halfLifeMs);
    weightSum += weight;
    weightedQuality += weight * outcome.quality;
    weightSquaredSum += weight * weight;
    if (lastOutcomeAt === null || outcome.at > lastOutcomeAt) lastOutcomeAt = outcome.at;
  }

  const observations = outcomes.length;

  if (observations === 0 || weightSum === 0) {
    return {
      agentId,
      score: 0.5,
      confidence: 0,
      margin: 0.5,
      effectiveSamples: 0,
      observations,
      lastOutcomeAt,
      computedAt: now,
    };
  }

  const score = weightedQuality / weightSum;
  const effectiveSamples = (weightSum * weightSum) / weightSquaredSum;
  const confidence = effectiveSamples / (effectiveSamples + CONFIDENCE_HALF_SATURATION);
  const varianceUnderMean = Math.max(score * (1 - score), 1e-6);
  const margin = Math.min(0.5, 1.96 * Math.sqrt(varianceUnderMean / Math.max(effectiveSamples, 1e-6)));

  return {
    agentId,
    score,
    confidence,
    margin,
    effectiveSamples,
    observations,
    lastOutcomeAt,
    computedAt: now,
  };
}
