import type { DecisionKind, DriftReport, PolicyDecision, PolicyThresholds, TrustScore } from "./types.js";

export const DEFAULT_THRESHOLDS: PolicyThresholds = {
  trustedMin: 0.75,
  reviewMin: 0.45,
  minConfidence: 0.6,
};

function clamp01(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a number in [0, 1]`);
  }
  return value;
}

/**
 * Maps calibrated evidence (score + confidence + drift state) onto an access
 * decision. Order of precedence:
 *
 * 1. Active drift denies outright — a degrading agent must not keep hold of
 *    high-trust permissions while the evidence says it is failing now.
 * 2. A score at or above trustedMin with enough confidence allows.
 * 3. Low confidence caps an otherwise-trusted agent at require-approval.
 * 4. Anything below reviewMin is denied.
 */
export class TrustPolicy {
  private thresholds: PolicyThresholds = { ...DEFAULT_THRESHOLDS };

  get config(): PolicyThresholds {
    return { ...this.thresholds };
  }

  update(patch: Partial<PolicyThresholds>): PolicyThresholds {
    const candidate: PolicyThresholds = {
      trustedMin: patch.trustedMin !== undefined ? clamp01(patch.trustedMin, "trustedMin") : this.thresholds.trustedMin,
      reviewMin: patch.reviewMin !== undefined ? clamp01(patch.reviewMin, "reviewMin") : this.thresholds.reviewMin,
      minConfidence:
        patch.minConfidence !== undefined ? clamp01(patch.minConfidence, "minConfidence") : this.thresholds.minConfidence,
    };
    if (candidate.trustedMin < candidate.reviewMin) {
      throw new TypeError("trustedMin must be >= reviewMin");
    }
    this.thresholds = candidate;
    return this.config;
  }

  evaluate(agentId: string, score: TrustScore, drift: DriftReport): PolicyDecision {
    const reasons: string[] = [];
    const { trustedMin, reviewMin, minConfidence } = this.thresholds;

    const tier: PolicyDecision["tier"] =
      score.score >= trustedMin && score.confidence >= minConfidence
        ? "trusted"
        : score.score >= reviewMin
          ? "provisional"
          : "restricted";

    let decision: DecisionKind;

    if (drift.state === "drifting") {
      decision = "deny";
      reasons.push(`active drift detected (z=${drift.zScore?.toFixed(2) ?? "?"}) — fail-safe deny`);
    } else if (drift.state === "watching") {
      decision = "require-approval";
      reasons.push(`early drift signal (z=${drift.zScore?.toFixed(2) ?? "?"}) — holding at approval`);
    } else if (score.score < reviewMin) {
      decision = "deny";
      reasons.push(`score ${score.score.toFixed(3)} below review floor ${reviewMin.toFixed(2)}`);
    } else if (tier === "trusted" && score.confidence >= minConfidence) {
      decision = "allow";
      reasons.push(`score ${score.score.toFixed(3)} >= trusted floor ${trustedMin.toFixed(2)} with confidence ${score.confidence.toFixed(2)}`);
    } else {
      decision = "require-approval";
      if (score.confidence < minConfidence) {
        reasons.push(`confidence ${score.confidence.toFixed(2)} below floor ${minConfidence.toFixed(2)} — evidence too thin to auto-approve`);
      } else {
        reasons.push(`score ${score.score.toFixed(3)} between review and trusted floors — approval required`);
      }
    }

    if (score.observations === 0) {
      reasons.push("no observations on record — cold start defaults apply");
    }

    return {
      agentId,
      decision,
      tier,
      reasons,
      score: score.score,
      confidence: score.confidence,
      drift: drift.state,
    };
  }
}

export const describeDecision = (d: PolicyDecision): string =>
  `${d.decision.toUpperCase()} (${d.tier}) — ${d.reasons.join("; ")}`;
