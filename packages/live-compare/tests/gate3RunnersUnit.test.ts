// Gate 3 (unkeyed noninferiority), Task 4 fix report: unit coverage the
// reviewer's "Needs fixes" pass called out as missing —
//  1. `computeWarmTrend`'s odd-n split rule (pure function, no children).
//  2. `runChildOnce`'s kill-on-protocol-violation path (a stub entrypoint
//     process, not a real kernel/sqlite child, so this stays fast).
// Both `computeWarmTrend` and `runChildOnce` are exported from runners.ts
// specifically so they're directly testable here without going through a
// full `runCold`/`runWarm` balanced schedule.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeWarmTrend, runChildOnce } from "../src/gate3/runners.js";
import type { PairOrder, Sample, SchedulePair } from "../src/gate3/schedule.js";

const stubEntry = resolve(import.meta.dirname, "fixtures/gate3/stub-protocol-violation-child.cjs");

/** Minimal, fully-typed synthetic `SchedulePair` — only `callerWallNs` matters to `computeWarmTrend`. */
function makePair(pairId: number, kernelWallNs: number, sqliteWallNs: number): SchedulePair {
  const order: PairOrder = "AB";
  const base = { corpus: "medium" as const, mode: "warm" as const, pairId, order, iteration: pairId, published: true as const };
  const kernel: Sample = { ...base, arm: "kernel", callerWallNs: kernelWallNs, childMaxRssBytes: 1 };
  const sqlite: Sample = { ...base, arm: "sqlite", callerWallNs: sqliteWallNs, childMaxRssBytes: 1 };
  return { pairId, order, kernel, sqlite };
}

describe("computeWarmTrend: odd-n split rule", () => {
  it("n=3: drops the middle pair, halves are single pairs 0 and 2", () => {
    // Pair 1 (the middle, dropped pair) carries an extreme ratio (999999/1)
    // that would massively distort either half's p95 ratio if it leaked in
    // — its ABSENCE from both computed ratios is the proof it was dropped.
    const pairs = [makePair(0, 100, 50), makePair(1, 999_999, 1), makePair(2, 300, 100)];

    const trend = computeWarmTrend(pairs);

    expect(trend.firstHalfP95Ratio).toBe(100 / 50);
    expect(trend.lastHalfP95Ratio).toBe(300 / 100);
  });

  it("n=5: drops the middle pair (index 2), halves are {0,1} and {3,4} with no overlap", () => {
    // Nearest-rank p95 of a 2-element ascending set is the larger element
    // (rank = ceil(0.95*2) = 2 -> the 2nd, i.e. max). Pair 2 (dropped)
    // again carries an extreme value that would distort either half's
    // ratio if it were included in it.
    const pairs = [
      makePair(0, 10, 5),
      makePair(1, 20, 10),
      makePair(2, 999_999, 1),
      makePair(3, 100, 50),
      makePair(4, 200, 100)
    ];

    const trend = computeWarmTrend(pairs);

    // firstHalf = {0,1}: kernel p95 = max(10,20) = 20, sqlite p95 = max(5,10) = 10.
    expect(trend.firstHalfP95Ratio).toBe(20 / 10);
    // lastHalf = {3,4}: kernel p95 = max(100,200) = 200, sqlite p95 = max(50,100) = 100.
    expect(trend.lastHalfP95Ratio).toBe(200 / 100);
  });

  it("throws when fewer than 2 pairs are given (no room for one pair per half)", () => {
    expect(() => computeWarmTrend([makePair(0, 1, 1)])).toThrow(/at least 2 pairs/);
  });
});

describe("runChildOnce: kill-on-protocol-violation", () => {
  let workDir: string | undefined;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  it(
    "rejects on a wire-protocol violation (non-done second line) AND actually kills the spawned process",
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "gate3-runchildonce-kill-"));
      const pidFile = join(workDir, "stub.pid");

      const originalEnv = process.env.STUB_PID_FILE;
      process.env.STUB_PID_FILE = pidFile;
      try {
        await expect(runChildOnce(stubEntry, { anything: true }, 15_000)).rejects.toThrow(
          /expected terminal "done" line/
        );
      } finally {
        if (originalEnv === undefined) delete process.env.STUB_PID_FILE;
        else process.env.STUB_PID_FILE = originalEnv;
      }

      const stubPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(stubPid)).toBe(true);

      // Poll for the process's actual death (SIGKILL is asynchronous at the
      // OS level) instead of asserting instantaneously — up to 3s, well
      // under this test's own bound, and far less than the stub's 60s
      // self-imposed hang, so a leaked process cannot pass by accident.
      const isAlive = (): boolean => {
        try {
          process.kill(stubPid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 3_000;
      while (isAlive() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(isAlive()).toBe(false);
    },
    20_000
  );
});
