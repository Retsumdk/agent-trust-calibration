import { createHash, timingSafeEqual } from "node:crypto";

export const sha256Hex = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const round4 = (value: number): number => Math.round(value * 10000) / 10000;
