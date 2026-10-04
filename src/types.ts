export type OutcomeKind = "success" | "partial" | "failure";

export interface OutcomeRecord {
  readonly taskId: string;
  readonly kind: OutcomeKind;
  readonly quality: number;
  readonly at: number;
}

export interface OutcomeInput {
  readonly taskId: string;
  readonly kind: OutcomeKind;
  readonly quality?: number | undefined;
  readonly at?: number | undefined;
}

export interface AgentProfile {
  readonly id: string;
  readonly registeredAt: number;
  readonly outcomes: OutcomeRecord[];
}

export interface TrustScore {
  readonly agentId: string;
  readonly score: number;
  readonly confidence: number;
  readonly margin: number;
  readonly effectiveSamples: number;
  readonly observations: number;
  readonly lastOutcomeAt: number | null;
  readonly computedAt: number;
}

export type DriftState = "insufficient-data" | "stable" | "watching" | "drifting";

export interface DriftReport {
  readonly agentId: string;
  readonly state: DriftState;
  readonly baselineMean: number | null;
  readonly recentMean: number | null;
  readonly zScore: number | null;
  readonly baselineSize: number;
  readonly recentSize: number;
  readonly evaluatedAt: number;
}

export type DecisionKind = "allow" | "require-approval" | "deny";

export type TrustTier = "trusted" | "provisional" | "restricted";

export interface PolicyDecision {
  readonly agentId: string;
  readonly decision: DecisionKind;
  readonly tier: TrustTier;
  readonly reasons: string[];
  readonly score: number;
  readonly confidence: number;
  readonly drift: DriftState;
}

export interface PolicyThresholds {
  trustedMin: number;
  reviewMin: number;
  minConfidence: number;
}

export interface CalibrationOptions {
  readonly halfLifeMs: number;
  readonly windowSize: number;
  readonly minPopulation: number;
  readonly breachThreshold: number;
  readonly watchThreshold: number;
}

export interface AgentSummary {
  readonly id: string;
  readonly registeredAt: number;
  readonly observations: number;
  readonly score: number;
  readonly confidence: number;
  readonly drift: DriftState;
  readonly decision: DecisionKind;
  readonly tier: TrustTier;
}

export interface RegistryState {
  readonly options: CalibrationOptions;
  readonly thresholds: PolicyThresholds;
  readonly agents: AgentProfile[];
}
