import type { CalibrationOptions, OutcomeKind } from "./types.js";

const KINDS: readonly OutcomeKind[] = ["success", "partial", "failure"];

export function isOutcomeKind(value: unknown): value is OutcomeKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function clamp01(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a number in [0, 1]`);
  }
  return value;
}

export function validateCalibration(raw: unknown): CalibrationOptions {
  const source = (raw ?? {}) as Record<string, unknown>;
  const halfLifeMs = Number(source["halfLifeMs"] ?? 7 * 24 * 60 * 60 * 1000);
  const windowSize = Number(source["windowSize"] ?? 10);
  const minPopulation = Number(source["minPopulation"] ?? 5);
  const breachThreshold = Number(source["breachThreshold"] ?? 2.0);
  const watchThreshold = Number(source["watchThreshold"] ?? 1.0);

  for (const [label, value] of [
    ["halfLifeMs", halfLifeMs],
    ["windowSize", windowSize],
    ["minPopulation", minPopulation],
    ["breachThreshold", breachThreshold],
    ["watchThreshold", watchThreshold],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive number`);
    }
  }
  if (breachThreshold < watchThreshold) {
    throw new TypeError("breachThreshold must be >= watchThreshold");
  }
  return { halfLifeMs, windowSize: Math.floor(windowSize), minPopulation: Math.floor(minPopulation), breachThreshold, watchThreshold };
}

export { clamp01 };
