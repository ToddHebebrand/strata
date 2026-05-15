import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionLog } from "../src/log";

describe("SessionLog", () => {
  it("collects events in memory and serializes one JSON object per line", () => {
    const log = new SessionLog();
    log.append({
      type: "session_start",
      ts: 1,
      model: "m",
      maxTurns: 25,
      task: "T03",
      actor: "agent-t03"
    });
    log.append({
      type: "tool_call",
      ts: 2,
      tool: "rename_symbol",
      args: { new_name: "X" },
      result_summary: "ok",
      ok: true,
      error: null,
      durationMs: 4,
      turn: 1
    });

    expect(log.events.length).toBe(2);
    const lines = log.toJsonl().trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).type).toBe("session_start");
    expect(JSON.parse(lines[1]!).tool).toBe("rename_symbol");
  });

  it("flushes to a file path when one is given", () => {
    const file = path.join(tmpdir(), `strata-log-${Date.now()}.jsonl`);
    const log = new SessionLog(file);
    log.append({
      type: "session_start",
      ts: 1,
      model: "m",
      maxTurns: 1,
      task: "T03",
      actor: "a"
    });
    log.flush();

    const onDisk = readFileSync(file, "utf8").trim().split("\n");
    expect(JSON.parse(onDisk[0]!).type).toBe("session_start");
  });

  it("summarizes a long tool result without storing the full text", () => {
    const log = new SessionLog();
    const summary = log.summarizeResult("x".repeat(5000));
    expect(summary.length).toBeLessThan(300);
  });
});
