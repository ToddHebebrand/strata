// Bridge-persistence slice, Task 9: the true-process RSS guard that becomes
// the A3 exit-verdict memory component (plan v2, review M5).
//
// The gate-3 harness's memory component measured the CHILD HARNESS process,
// not the daemon or its persistent bridge worker; A3 replaces that
// placeholder with this guard's predicate over the REAL processes:
//
//   - `measureTrueRss` samples the daemon and the persistent worker via
//     `ps -o rss=` (true OS-observed resident set, KiB -> bytes);
//   - PID continuity: the daemon PID comes from the spawned child; the
//     persistent worker PID is discovered from the OS as the daemon's
//     `node .../worker.js --persistent` child (`pgrep -P`) — the daemon
//     deliberately exposes no worker PID over the protocol, and this guard
//     adds no protocol surface for it. Every sample re-verifies both PIDs
//     are alive AND unchanged since sampler creation: a silent worker
//     respawn (new PID) is a continuity violation that invalidates the run;
//   - Sampling protocol (pre-registered): one sample immediately after each
//     mutation publishes, plus one after a 200 ms quiescence beat;
//     per-iteration high-water = max of the two; the full series is retained;
//   - Predicates (pre-registered): medium leak check over N=12 warm
//     mutations (`LEAK_FACTOR`), absolute big1k combined-RSS cap
//     (`PERSISTENT_1K_RSS_CAP`; the cap MEASUREMENT is a manual one-off with
//     the release binary, deliberately NOT part of this key-free chain test).
//
// See docs/superpowers/plans/2026-07-23-bridge-persistence-slice.md, Task 9.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoordinationClient } from "../src/client.js";
import {
  ADVANCE_DEADLINE_MS,
  DISCOVERY_DEADLINE_MS,
  MAX_ADVANCE_ATTEMPTS,
  SUBMIT_DEADLINE_MS,
  TASK_PROMPT,
  credentialFreeEnv,
  expectResult,
  kernelServiceBinary
} from "../src/gate1.js";
import { startKernelService } from "../src/service.js";
import {
  LEAK_FACTOR,
  MEDIUM_LEAK_ITERATIONS,
  PERSISTENT_1K_RSS_CAP,
  QUIESCENCE_MS,
  createRssSampler,
  measureTrueRss,
  persistentMemoryVerdict,
  waitForPersistentWorkerPid
} from "../src/persistence/memory-guard.js";
import { ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corpusRoot = resolve(repoRoot, "examples/medium");

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure predicate math over synthetic series (no processes involved).
// ---------------------------------------------------------------------------

describe("persistentMemoryVerdict (pre-registered predicate math)", () => {
  /** Synthetic 12-iteration high-water series: baseline window (iterations
   * 1-4) around 400 MB, tail window (iterations 9-12) scaled by `tailRatio`
   * relative to the baseline high-water. */
  function syntheticSeries(tailRatio: number): number[] {
    const baseline = [400 * MB, 402 * MB, 401 * MB, 399 * MB];
    const middle = [403 * MB, 401 * MB, 402 * MB, 400 * MB];
    const tailPeak = Math.round(402 * MB * tailRatio);
    const tail = [tailPeak - 2 * MB, tailPeak, tailPeak - MB, tailPeak - 3 * MB];
    return [...baseline, ...middle, ...tail];
  }

  it("pre-registers the constants", () => {
    expect(LEAK_FACTOR).toBe(1.15);
    expect(MEDIUM_LEAK_ITERATIONS).toBe(12);
    expect(QUIESCENCE_MS).toBe(200);
    expect(Number.isFinite(PERSISTENT_1K_RSS_CAP)).toBe(true);
    // The cap is a measured-basis absolute bound on combined daemon+worker
    // RSS for big1k; anything below 100 MB could not hold a hydrated
    // 55k-node mirror and would indicate a units mistake.
    expect(PERSISTENT_1K_RSS_CAP).toBeGreaterThan(100 * MB);
  });

  it("passes the leak check when the tail high-water stays within LEAK_FACTOR of the baseline", () => {
    const verdict = persistentMemoryVerdict({ mediumHighWaterBytes: syntheticSeries(1.05) });
    expect(verdict.leakPass).toBe(true);
    expect(verdict.capPass).toBeUndefined();
    expect(verdict.state).toBe("pass");
    expect(verdict.tailHighWaterBytes).toBeLessThanOrEqual(verdict.leakLimitBytes);
  });

  it("fails the leak check when the tail high-water exceeds baseline x LEAK_FACTOR", () => {
    const verdict = persistentMemoryVerdict({ mediumHighWaterBytes: syntheticSeries(1.3) });
    expect(verdict.leakPass).toBe(false);
    expect(verdict.state).toBe("fail");
  });

  it("fails on a big1k cap breach even when the medium leak check passes", () => {
    const verdict = persistentMemoryVerdict(
      {
        mediumHighWaterBytes: syntheticSeries(1.0),
        big1kCombinedBytes: [PERSISTENT_1K_RSS_CAP + 1]
      },
      { persistent1kRssCapBytes: PERSISTENT_1K_RSS_CAP }
    );
    expect(verdict.leakPass).toBe(true);
    expect(verdict.capPass).toBe(false);
    expect(verdict.state).toBe("fail");
  });

  it("computes capPass=true when big1k samples stay under the cap", () => {
    const verdict = persistentMemoryVerdict({
      mediumHighWaterBytes: syntheticSeries(1.0),
      big1kCombinedBytes: [PERSISTENT_1K_RSS_CAP - MB, PERSISTENT_1K_RSS_CAP - 2 * MB]
    });
    expect(verdict.capPass).toBe(true);
    expect(verdict.state).toBe("pass");
    expect(verdict.big1kPeakBytes).toBe(PERSISTENT_1K_RSS_CAP - MB);
  });

  it("refuses a series shorter than the pre-registered N=12", () => {
    expect(() =>
      persistentMemoryVerdict({ mediumHighWaterBytes: [400 * MB, 401 * MB] })
    ).toThrow(/12/);
  });
});

// ---------------------------------------------------------------------------
// measureTrueRss against a real, known-alive process (this one).
// ---------------------------------------------------------------------------

describe("measureTrueRss", () => {
  it("reads true OS RSS in bytes for live PIDs", () => {
    const sample = measureTrueRss({ daemon: process.pid, worker: process.pid });
    expect(sample.daemonRss).toBeGreaterThan(1 * MB);
    expect(sample.workerRss).toBeGreaterThan(1 * MB);
    expect(sample.combined).toBe(sample.daemonRss + sample.workerRss);
  });

  it("throws when a PID is dead", () => {
    // Spawn-and-reap a child so its PID is known-dead.
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const dead = spawnSync("true", { stdio: "ignore" }).pid ?? 999999;
    expect(() => measureTrueRss({ daemon: dead, worker: process.pid })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The real thing: N=12 warm mutations on examples/medium with
// --persistent-bridge, true-process sampling, PID continuity throughout.
// ---------------------------------------------------------------------------

const cleanup: string[] = [];
afterAll(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

/** Twelve alternating interface renames ending back at the original name. */
const RENAMES: readonly [string, string][] = Array.from({ length: 12 }, (_, index) =>
  index % 2 === 0 ? (["User", "Account"] as [string, string]) : (["Account", "User"] as [string, string])
);

async function publishRename(
  client: CoordinationClient,
  fromName: string,
  toName: string
): Promise<void> {
  const discovery = expectResult(
    await client.findDeclarations(fromName, { kind: "interface" }, DISCOVERY_DEADLINE_MS),
    "declarations"
  );
  expect(discovery.declarations.length).toBe(1);
  const begun = expectResult(await client.beginChangeSet(TASK_PROMPT, SUBMIT_DEADLINE_MS), "change_set");
  expectResult(
    await client.addIntent(
      begun.changeSetId,
      { type: "rename_symbol", declarationId: discovery.declarations[0]!.nodeId, newName: toName },
      SUBMIT_DEADLINE_MS
    ),
    "change_set"
  );
  expectResult(await client.submitChangeSet(begun.changeSetId, SUBMIT_DEADLINE_MS), "change_set");
  for (let attempt = 0; attempt < MAX_ADVANCE_ATTEMPTS; attempt += 1) {
    const advanced = expectResult(
      await client.advanceChangeSet(begun.changeSetId, ADVANCE_DEADLINE_MS),
      "change_set"
    );
    if (advanced.state === "published" && advanced.operationId !== null) return;
  }
  throw new Error(`rename ${fromName}->${toName} did not publish within ${MAX_ADVANCE_ATTEMPTS} advances`);
}

describe("true-process RSS guard (N=12 warm mutations, --persistent-bridge)", () => {
  beforeAll(() => ensureBuilt(), 600_000);

  it("holds PID continuity across 12 mutations and passes the pre-registered leak check", async () => {
    const directory = mkdtempSync(join(tmpdir(), "strata-memory-guard-"));
    const service = await startKernelService(corpusRoot, {
      binaryPath: kernelServiceBinary(),
      env: credentialFreeEnv(),
      directory,
      extraArgs: ["--persistent-bridge"]
    });
    try {
      const daemonPid = service.child.pid;
      expect(daemonPid).toBeGreaterThan(0);

      const client = new CoordinationClient({
        socketPath: service.socketPath,
        clientId: `memory-guard-test:${randomUUID()}`
      });
      await client.hello(DISCOVERY_DEADLINE_MS);

      // Eager hydration (Task 6): the persistent worker child exists at
      // startup; discover it from the OS.
      const workerPid = await waitForPersistentWorkerPid(daemonPid!, 30_000);
      expect(workerPid).toBeGreaterThan(0);
      expect(workerPid).not.toBe(daemonPid);

      const sampler = createRssSampler({ daemon: daemonPid!, worker: workerPid });
      const highWaters: number[] = [];
      for (let iteration = 0; iteration < RENAMES.length; iteration += 1) {
        const [fromName, toName] = RENAMES[iteration]!;
        await publishRename(client, fromName, toName);
        // Pre-registered protocol: post-publish sample + 200 ms quiescence
        // beat sample; per-iteration high-water = max of the two.
        const sampled = await sampler.sampleIteration(`iteration-${iteration + 1}`);
        highWaters.push(sampled.highWaterBytes);
      }

      // PID continuity held: the sampler never observed a death or respawn,
      // and the daemon's persistent worker child is STILL the same PID.
      expect(sampler.continuityHeld()).toBe(true);
      expect(await waitForPersistentWorkerPid(daemonPid!, 5_000)).toBe(workerPid);
      expect(sampler.pids()).toEqual({ daemon: daemonPid, worker: workerPid });

      // Full series retained: 12 iterations x 2 samples each.
      const samples = sampler.samples();
      expect(samples.length).toBe(RENAMES.length * 2);
      for (const sample of samples) {
        expect(sample.daemonRss).toBeGreaterThan(1 * MB);
        expect(sample.workerRss).toBeGreaterThan(1 * MB);
        expect(sample.combined).toBe(sample.daemonRss + sample.workerRss);
      }

      // The A3 medium leak predicate over the warm series.
      const verdict = persistentMemoryVerdict({ mediumHighWaterBytes: highWaters });
      expect(verdict.leakPass, JSON.stringify(verdict, null, 2)).toBe(true);
      expect(verdict.capPass).toBeUndefined();
      expect(verdict.state).toBe("pass");
      // The verdict object is the exact shape Task 11's A3 wiring consumes.
      expect(verdict).toMatchObject({
        leakPass: true,
        state: "pass",
        baselineHighWaterBytes: expect.any(Number),
        tailHighWaterBytes: expect.any(Number),
        leakLimitBytes: expect.any(Number)
      });
    } finally {
      await service.stop({ preserveDirectory: true });
      cleanup.push(directory);
    }
  }, 900_000);
});
