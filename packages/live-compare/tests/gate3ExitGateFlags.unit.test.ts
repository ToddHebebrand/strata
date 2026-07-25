// Bridge-persistence slice, Task 11: unit coverage for the exit-gate harness
// surface added to run-big.ts — the CLI parsing (`--exit-gate persistence`,
// `--artifact-base`), the binary-profile inference, and the pure A3 memory
// assembly (`assembleA3Memory`) that replaces the placeholder memory
// component in exit-gate mode ONLY.
//
// The DEFAULT path's byte-identical behavior is pinned three ways: (1) the
// no-flags parse below returns { smoke:false, exitGate:null,
// artifactBase:null }, and `main` only diverges behind `cli.exitGate !==
// null` / `cli.artifactBase !== null` guards; (2) the pre-existing
// gate3Report.unit.test.ts / gate3RunBig.unit.test.ts suites (unmodified)
// still pin the default report pipeline; (3) the recorded gate-3 artifact CI
// test (unmodified) still validates the committed default-path artifact.
import { describe, expect, it } from "vitest";
import {
  EXIT_GATE_DEFAULT_ARTIFACT_BASE,
  assembleA3Memory,
  binaryProfileOf,
  parseRunBigArgs
} from "../src/gate3/run-big.js";
import { corpusState, buildGate3CorpusReport } from "../src/gate3/report.js";
import {
  LEAK_FACTOR,
  MEDIUM_LEAK_ITERATIONS,
  PERSISTENT_1K_RSS_CAP
} from "../src/persistence/memory-guard.js";
import type { MediumLeakCheckOutcome, WarmScheduleSampling } from "../src/persistence/exit-gate-memory.js";
import type { RatioVerdict } from "../src/gate3/stats.js";

const MB = 1024 * 1024;

describe("parseRunBigArgs", () => {
  it("no flags -> all defaults (the byte-identical default path)", () => {
    expect(parseRunBigArgs([])).toEqual({ smoke: false, exitGate: null, artifactBase: null });
  });

  it("--smoke alone stays exactly the pre-Task-11 smoke mode", () => {
    expect(parseRunBigArgs(["--smoke"])).toEqual({ smoke: true, exitGate: null, artifactBase: null });
  });

  it("--exit-gate persistence turns on exit-gate mode and defaults the artifact base", () => {
    expect(parseRunBigArgs(["--exit-gate", "persistence"])).toEqual({
      smoke: false,
      exitGate: "persistence",
      artifactBase: EXIT_GATE_DEFAULT_ARTIFACT_BASE
    });
    expect(EXIT_GATE_DEFAULT_ARTIFACT_BASE).toBe("bridge-persistence-exit-gate");
  });

  it("--smoke --exit-gate persistence composes", () => {
    expect(parseRunBigArgs(["--smoke", "--exit-gate", "persistence"])).toEqual({
      smoke: true,
      exitGate: "persistence",
      artifactBase: EXIT_GATE_DEFAULT_ARTIFACT_BASE
    });
  });

  it("--artifact-base overrides the exit-gate default", () => {
    expect(parseRunBigArgs(["--exit-gate", "persistence", "--artifact-base", "bridge-persistence-exit-gate"])).toEqual({
      smoke: false,
      exitGate: "persistence",
      artifactBase: "bridge-persistence-exit-gate"
    });
  });

  it("--artifact-base without --exit-gate is honored standalone", () => {
    expect(parseRunBigArgs(["--artifact-base", "my-profile"])).toEqual({
      smoke: false,
      exitGate: null,
      artifactBase: "my-profile"
    });
  });

  it("rejects an unknown --exit-gate value and a missing value", () => {
    expect(() => parseRunBigArgs(["--exit-gate", "bogus"])).toThrow(/persistence/);
    expect(() => parseRunBigArgs(["--exit-gate"])).toThrow(/persistence/);
  });

  it("rejects a missing or path-like --artifact-base value", () => {
    expect(() => parseRunBigArgs(["--artifact-base"])).toThrow(/required/);
    expect(() => parseRunBigArgs(["--artifact-base", "--smoke"])).toThrow(/required/);
    expect(() => parseRunBigArgs(["--artifact-base", "../escape"])).toThrow(/path/);
    expect(() => parseRunBigArgs(["--artifact-base", "a/b"])).toThrow(/path/);
  });
});

describe("binaryProfileOf", () => {
  it("infers release/debug/unknown from the binary path", () => {
    expect(binaryProfileOf("/repo/target/release/strata-kernel-service")).toBe("release");
    expect(binaryProfileOf("/repo/target/debug/strata-kernel-service")).toBe("debug");
    expect(binaryProfileOf("/somewhere/else/strata-kernel-service")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// assembleA3Memory: the pure A3 mapping (exit-gate mode only).
// ---------------------------------------------------------------------------

function leakOutcome(overrides: Partial<MediumLeakCheckOutcome> = {}): MediumLeakCheckOutcome {
  // A clean, non-leaking 12-iteration high-water series around 400 MB.
  const highWaterBytes = Array.from({ length: MEDIUM_LEAK_ITERATIONS }, (_, i) => (400 + (i % 3)) * MB);
  return {
    highWaterBytes,
    samples: [],
    daemonPid: 111,
    workerPid: 222,
    continuityHeld: true,
    ...overrides
  };
}

function warmSampling(overrides: Partial<WarmScheduleSampling> = {}): WarmScheduleSampling {
  return {
    combinedBytes: [700 * MB, 720 * MB, 710 * MB],
    samples: [],
    pids: { daemon: 111, worker: 222 },
    continuityHeld: true,
    ...overrides
  };
}

const OBSERVED = { mediumSqliteRss: 90 * MB, big1kSqliteRss: 120 * MB, baselineSqliteRss: 80 * MB };

describe("assembleA3Memory", () => {
  it("clean leak + under-cap samples -> medium PASS, big1k PASS; sqlite slots PASS by definition", () => {
    const a3 = assembleA3Memory({ mediumLeak: leakOutcome(), big1kWarm: warmSampling(), observed: OBSERVED });
    expect(a3.medium.kernel.state).toBe("PASS");
    expect(a3.big1k.kernel.state).toBe("PASS");
    expect(a3.medium.sqlite.state).toBe("PASS");
    expect(a3.big1k.sqlite.state).toBe("PASS");
    expect(a3.memoryBlock.medium.state).toBe("PASS");
    expect(a3.memoryBlock.big1k.capPass).toBe(true);
    expect(a3.memoryBlock.big1k.peakBytes).toBe(720 * MB);
    expect(a3.memoryBlock.big1k.capBytes).toBe(PERSISTENT_1K_RSS_CAP);
    expect(a3.memoryBlock.medium.leakVerdict?.leakPass).toBe(true);
  });

  it("a leaking medium tail -> medium FAIL (the Task 9 LEAK_FACTOR predicate)", () => {
    const series = leakOutcome();
    // Tail (iterations 9-12) beyond baseline x LEAK_FACTOR.
    for (let i = 8; i < 12; i += 1) series.highWaterBytes[i] = Math.round(402 * MB * (LEAK_FACTOR + 0.2));
    const a3 = assembleA3Memory({ mediumLeak: series, big1kWarm: warmSampling(), observed: OBSERVED });
    expect(a3.medium.kernel.state).toBe("FAIL");
    expect(a3.big1k.kernel.state).toBe("PASS");
  });

  it("a big1k cap breach -> big1k FAIL, absoluteCapPass false", () => {
    const a3 = assembleA3Memory({
      mediumLeak: leakOutcome(),
      big1kWarm: warmSampling({ combinedBytes: [PERSISTENT_1K_RSS_CAP + 1] }),
      observed: OBSERVED
    });
    expect(a3.big1k.kernel.state).toBe("FAIL");
    expect(a3.big1k.kernel.absoluteCapPass).toBe(false);
    expect(a3.memoryBlock.big1k.capPass).toBe(false);
  });

  it("a mid-run continuity violation -> INCONCLUSIVE with the reason recorded", () => {
    const a3 = assembleA3Memory({
      mediumLeak: leakOutcome({
        continuityHeld: false,
        inconclusiveReason: "medium leak check: persistent worker PID changed",
        highWaterBytes: [400 * MB, 401 * MB]
      }),
      big1kWarm: warmSampling({
        continuityHeld: false,
        inconclusiveReason: "big1k warm sampling: persistent worker PID changed: expected 222, found 333 (respawn)"
      }),
      observed: OBSERVED
    });
    expect(a3.medium.kernel.state).toBe("INCONCLUSIVE");
    expect(a3.big1k.kernel.state).toBe("INCONCLUSIVE");
    expect(a3.memoryBlock.medium.inconclusiveReason).toMatch(/PID changed/);
    expect(a3.memoryBlock.big1k.inconclusiveReason).toMatch(/respawn/);
  });

  it("a short (cut-off) leak series or zero big1k samples -> INCONCLUSIVE, never PASS", () => {
    const a3 = assembleA3Memory({
      mediumLeak: leakOutcome({ highWaterBytes: [400 * MB, 401 * MB, 402 * MB] }),
      big1kWarm: warmSampling({ combinedBytes: [], samples: [] }),
      observed: OBSERVED
    });
    expect(a3.medium.kernel.state).toBe("INCONCLUSIVE");
    expect(a3.memoryBlock.medium.inconclusiveReason).toMatch(/3\/12/);
    expect(a3.big1k.kernel.state).toBe("INCONCLUSIVE");
  });

  it("folds into corpusState exactly like any memory verdict (A3 semantics: wall ∧ lifecycle ∧ A3 memory)", () => {
    const pass: RatioVerdict = { p95Kernel: 1, p95Sqlite: 1, pointRatio: 1, ucb95: 1.1, lcb95: 0.9, state: "PASS" };
    const a3 = assembleA3Memory({ mediumLeak: leakOutcome(), big1kWarm: warmSampling(), observed: OBSERVED });
    const passingCorpus = buildGate3CorpusReport({
      cold: pass,
      warm: pass,
      warmTrend: { firstHalfP95Ratio: 1, lastHalfP95Ratio: 1 },
      memory: a3.big1k,
      lifecycle: { kernel: 4, sqlite: 4 }
    });
    expect(corpusState(passingCorpus)).toBe("PASS");

    const breach = assembleA3Memory({
      mediumLeak: leakOutcome(),
      big1kWarm: warmSampling({ combinedBytes: [PERSISTENT_1K_RSS_CAP + 1] }),
      observed: OBSERVED
    });
    const failingCorpus = buildGate3CorpusReport({ ...passingCorpus, memory: breach.big1k });
    expect(corpusState(failingCorpus)).toBe("FAIL");
  });
});
