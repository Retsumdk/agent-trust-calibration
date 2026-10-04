import { AuditLog } from "./audit.js";
import { evaluateDrift } from "./drift.js";
import { TrustError } from "./errors.js";
import { round4 } from "./hashing.js";
import { writeJsonAtomic, readJsonFile } from "./persistence.js";
import { TrustPolicy } from "./policy.js";
import { computeScore } from "./scoring.js";
import { isOutcomeKind, validateCalibration } from "./config.js";
import type {
  AgentProfile,
  AgentSummary,
  CalibrationOptions,
  DriftReport,
  OutcomeInput,
  OutcomeKind,
  OutcomeRecord,
  PolicyDecision,
  PolicyThresholds,
  RegistryState,
  TrustScore,
} from "./types.js";

export const DEFAULT_OPTIONS: CalibrationOptions = {
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,
  windowSize: 10,
  minPopulation: 5,
  breachThreshold: 2.0,
  watchThreshold: 1.0,
};

export interface RegistrySettings {
  readonly options?: Partial<CalibrationOptions>;
  readonly thresholds?: Partial<PolicyThresholds>;
  readonly statePath?: string | undefined;
  readonly auditPath?: string | undefined;
  readonly clock?: () => number;
}

function scoreless(kind: OutcomeKind): number {
  return kind === "success" ? 1 : kind === "partial" ? 0.5 : 0;
}

function validateAgentId(id: string): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new TrustError("VALIDATION", "agent id must be a non-empty string");
  }
  if (id.length > 128) {
    throw new TrustError("VALIDATION", "agent id must be at most 128 characters");
  }
  return id.trim();
}

/**
 * Central calibration store: agent registry, outcome ledger, scoring, drift
 * evaluation and policy decisions in one durable object. When `statePath` is
 * configured the full registry state is persisted atomically after every
 * mutation and reloaded on construction; every mutation is also appended to
 * the hash-chained audit ledger when `auditPath` is configured.
 */
export class TrustRegistry {
  private readonly agents = new Map<string, AgentProfile>();
  private readonly policy: TrustPolicy;
  private options: CalibrationOptions;
  private readonly audit: AuditLog | undefined;
  private readonly statePath: string | undefined;
  private readonly clock: () => number;

  constructor(settings: RegistrySettings = {}) {
    this.options = validateCalibration({ ...DEFAULT_OPTIONS, ...settings.options });
    this.policy = new TrustPolicy();
    if (settings.thresholds !== undefined) {
      this.policy.update(settings.thresholds);
    }
    this.clock = settings.clock ?? Date.now;
    this.statePath = settings.statePath;
    this.audit = settings.auditPath !== undefined ? new AuditLog(settings.auditPath, this.clock) : undefined;

    if (this.statePath !== undefined) {
      const raw = readJsonFile(this.statePath);
      if (raw !== undefined) {
        this.loadState(raw);
      }
    }
  }

  private loadState(raw: unknown): void {
    const state = raw as Partial<RegistryState>;
    if (!Array.isArray(state.agents)) {
      throw new TrustError("CORRUPTION", "state file has no agents array");
    }
    for (const profile of state.agents as AgentProfile[]) {
      if (typeof profile?.id !== "string" || !Array.isArray(profile.outcomes)) {
        throw new TrustError("CORRUPTION", "state file has a malformed agent profile");
      }
      this.agents.set(profile.id, { id: profile.id, registeredAt: Number(profile.registeredAt), outcomes: profile.outcomes });
    }
    try {
      this.options = validateCalibration({ ...DEFAULT_OPTIONS, ...state.options });
      this.policy.update(state.thresholds ?? {});
    } catch (error) {
      throw new TrustError("CORRUPTION", `state file has invalid calibration data: ${(error as Error).message}`);
    }
  }

  private persist(): void {
    if (this.statePath === undefined) return;
    writeJsonAtomic(this.statePath, this.exportState());
  }

  private auditAppend(kind: string, data: Record<string, unknown>): void {
    this.audit?.append(kind, data);
  }

  get auditLog(): AuditLog | undefined {
    return this.audit;
  }

  get calibration(): CalibrationOptions {
    return { ...this.options };
  }

  get thresholds(): PolicyThresholds {
    return this.policy.config;
  }

  recalibrate(patch: Partial<CalibrationOptions>): CalibrationOptions {
    this.options = validateCalibration({ ...this.options, ...patch });
    this.auditAppend("calibration.updated", { ...this.options });
    this.persist();
    return this.calibration;
  }

  updateThresholds(patch: Partial<PolicyThresholds>): PolicyThresholds {
    const next = this.policy.update(patch);
    this.auditAppend("policy.updated", { ...next });
    this.persist();
    return next;
  }

  registerAgent(id: string): AgentProfile {
    const clean = validateAgentId(id);
    if (this.agents.has(clean)) {
      throw new TrustError("CONFLICT", `agent "${clean}" is already registered`);
    }
    const profile: AgentProfile = { id: clean, registeredAt: this.clock(), outcomes: [] };
    this.agents.set(clean, profile);
    this.auditAppend("agent.registered", { agentId: clean });
    this.persist();
    return profile;
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  private require(agentId: string): AgentProfile {
    const profile = this.agents.get(agentId);
    if (profile === undefined) {
      throw new TrustError("NOT_FOUND", `agent "${agentId}" is not registered`);
    }
    return profile;
  }

  recordOutcome(agentId: string, input: OutcomeInput): OutcomeRecord {
    const profile = this.require(agentId);
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
    if (taskId.length === 0) {
      throw new TrustError("VALIDATION", "taskId must be a non-empty string");
    }
    if (!isOutcomeKind(input.kind)) {
      throw new TrustError("VALIDATION", 'kind must be one of "success", "partial", "failure"');
    }
    const now = this.clock();
    const quality =
      input.quality !== undefined
        ? (() => {
            const q = Number(input.quality);
            if (!Number.isFinite(q) || q < 0 || q > 1) {
              throw new TrustError("VALIDATION", "quality must be a number in [0, 1]");
            }
            return q;
          })()
        : scoreless(input.kind);
    const at = input.at !== undefined ? Number(input.at) : now;
    if (!Number.isFinite(at) || at < 0) {
      throw new TrustError("VALIDATION", "at must be a non-negative epoch timestamp");
    }

    const record: OutcomeRecord = { taskId, kind: input.kind, quality, at };
    profile.outcomes.push(record);
    this.auditAppend("outcome.recorded", {
      agentId,
      taskId,
      kind: record.kind,
      quality: round4(record.quality),
      at: record.at,
    });
    this.persist();
    return record;
  }

  score(agentId: string): TrustScore {
    const profile = this.require(agentId);
    return computeScore(agentId, profile.outcomes, this.clock(), this.options.halfLifeMs);
  }

  drift(agentId: string): DriftReport {
    const profile = this.require(agentId);
    return evaluateDrift(agentId, profile.outcomes, this.clock(), this.options);
  }

  decide(agentId: string): PolicyDecision {
    this.require(agentId);
    return this.policy.evaluate(agentId, this.score(agentId), this.drift(agentId));
  }

  listAgents(): AgentSummary[] {
    const summaries: AgentSummary[] = [];
    for (const id of [...this.agents.keys()].sort()) {
      const profile = this.agents.get(id)!;
      const score = this.score(id);
      const drift = this.drift(id);
      const decision = this.policy.evaluate(id, score, drift);
      summaries.push({
        id,
        registeredAt: profile.registeredAt,
        observations: profile.outcomes.length,
        score: round4(score.score),
        confidence: round4(score.confidence),
        drift: drift.state,
        decision: decision.decision,
        tier: decision.tier,
      });
    }
    return summaries;
  }

  exportState(): RegistryState {
    return {
      options: this.calibration,
      thresholds: this.thresholds,
      agents: [...this.agents.values()].map((profile) => ({
        id: profile.id,
        registeredAt: profile.registeredAt,
        outcomes: [...profile.outcomes],
      })),
    };
  }
}