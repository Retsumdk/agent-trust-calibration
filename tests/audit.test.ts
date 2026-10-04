import { describe, expect, test } from "bun:test";
import { AuditLog } from "../src/audit.js";
import { CorruptionError } from "../src/errors.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = (): string => mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "audit-"));

describe("AuditLog", () => {
  test("entries chain and verify", () => {
    let tick = 0;
    const log = new AuditLog(undefined, () => tick++);
    log.append("agent.registered", { agentId: "a" });
    log.append("outcome.recorded", { agentId: "a", taskId: "t" });
    const report = log.report();
    expect(report.intact).toBe(true);
    expect(report.entries).toBe(2);
    const [first, second] = log.tail(2);
    expect(second!.prevHash).toBe(log.hashOf(first!));
  });

  test("reload preserves the chain across instances", () => {
    const d = dir();
    try {
      const path = join(d, "ledger.jsonl");
      const first = new AuditLog(path, () => 1);
      first.append("a", { n: 1 });
      first.append("b", { n: 2 });
      const second = new AuditLog(path, () => 2);
      expect(second.size).toBe(2);
      expect(second.head).toBe(first.head);
      expect(second.append("c", { n: 3 }).seq).toBe(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("mid-file tampering is a CorruptionError", () => {
    const d = dir();
    try {
      const path = join(d, "ledger.jsonl");
      const first = new AuditLog(path, () => 1);
      first.append("a", { n: 1 });
      first.append("b", { n: 2 });
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
      const tampered = JSON.parse(lines[0]!) as Record<string, unknown>;
      tampered["data"] = { n: 999 };
      lines[0] = JSON.stringify(tampered);
      writeFileSync(path, lines.join("\n") + "\n", "utf8");
      expect(() => new AuditLog(path, () => 1)).toThrow(CorruptionError);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("sequence breaks are corruption too", () => {
    const d = dir();
    try {
      const path = join(d, "ledger.jsonl");
      const first = new AuditLog(path, () => 1);
      first.append("a", { n: 1 });
      first.append("b", { n: 2 });
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
      // Removing the genesis entry leaves a follower whose seq (1) no longer
      // matches its file position (0) — a sequence break, not a torn tail.
      lines.splice(0, 1);
      writeFileSync(path, lines.join("\n") + "\n", "utf8");
      expect(() => new AuditLog(path, () => 1)).toThrow(/ledger sequence break/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a torn final line is tolerated (crash mid-append)", () => {
    const d = dir();
    try {
      const path = join(d, "ledger.jsonl");
      const first = new AuditLog(path, () => 1);
      first.append("a", { n: 1 });
      const body = readFileSync(path, "utf8");
      writeFileSync(path, body + '{"seq":1,"prevHash":"x",', "utf8");
      const second = new AuditLog(path, () => 2);
      expect(second.size).toBe(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("empty kinds are rejected", () => {
    const log = new AuditLog(undefined, () => 0);
    expect(() => log.append("", {})).toThrow(/non-empty/);
  });
});
