/**
 * agent-trust-calibration
 *
 * Dynamic trust calibration for autonomous agents: recency-weighted
 * performance scoring, statistical drift detection, confidence-gated access
 * policy, and a hash-chained audit ledger. Zero runtime dependencies.
 *
 * Built by Retsumdk — MIT licensed.
 */

export { TrustRegistry, DEFAULT_OPTIONS, type RegistrySettings } from "./registry.js";
export type {
  AgentProfile,
  AgentSummary,
  CalibrationOptions,
  DecisionKind,
  DriftReport,
  DriftState,
  OutcomeInput,
  OutcomeKind,
  OutcomeRecord,
  PolicyDecision,
  PolicyThresholds,
  RegistryState,
  TrustScore,
} from "./types.js";
export { TrustError, CorruptionError, type ErrorCode } from "./errors.js";
export { computeScore, defaultQuality, CONFIDENCE_HALF_SATURATION } from "./scoring.js";
export { evaluateDrift } from "./drift.js";
export { TrustPolicy, DEFAULT_THRESHOLDS, describeDecision } from "./policy.js";
export { AuditLog, type AuditEntry, type AuditReport } from "./audit.js";
export { validateCalibration, isOutcomeKind } from "./config.js";
export { createTrustServer, listenTrustServer, type ServerHandle } from "./server.js";
export { runDemo } from "./demo.js";
export { runCli } from "./cli.js";
export { sha256Hex, constantTimeEqual } from "./hashing.js";
export { writeJsonAtomic, readJsonFile } from "./persistence.js";
