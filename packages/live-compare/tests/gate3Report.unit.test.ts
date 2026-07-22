// Gate 3 (unkeyed noninferiority), Task 7: report builder, provenance
// binding, tri-state artifact writer.
//
// Fixture-only unit suite (per the plan: "Unit tests use FIXTURES ...
// construct RatioVerdicts/MemoryVerdicts directly") — no children, no
// daemon. `RatioVerdict`/`MemoryVerdict` fixtures are hand-built directly
// (not run through `ratioVerdict`/`memoryVerdict`) so the exact ucb95/lcb95
// values the brief specifies (PASS 1.18, FAIL lcb95 1.4, an INCONCLUSIVE
// straddle) are pinned exactly, independent of the bootstrap's own
// behavior (already covered by gate3Stats.unit.test.ts). One real,
// unmocked `collectProvenance()` smoke assertion at the bottom exercises
// the genuine impure collectors (cheap: reads the already-built
// dist/gate3/** and target/debug/strata-kernel-service, one git + one
// rustc subprocess).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectProvenance, type Provenance } from "../src/gate3/provenance.js";
import {
  buildGate3CorpusReport,
  buildGate3Report,
  corpusState,
  renderGate3Markdown,
  writeGate3Artifacts,
  type Gate3CorpusReport
} from "../src/gate3/report.js";
import type { PairOrder, Sample, SchedulePair } from "../src/gate3/schedule.js";
import type { MemoryVerdict, RatioVerdict, RatioVerdictState } from "../src/gate3/stats.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** ucb95 1.18 <= 1.25 -> PASS, per the brief's Step-1 PASS case. */
const PASS_RATIO: RatioVerdict = {
  p95Kernel: 118_000_000,
  p95Sqlite: 100_000_000,
  pointRatio: 1.18,
  ucb95: 1.18,
  lcb95: 1.05,
  state: "PASS"
};

/** lcb95 1.4 > 1.25 -> FAIL, per the brief's Step-1 FAIL case. */
const FAIL_RATIO: RatioVerdict = {
  p95Kernel: 140_000_000,
  p95Sqlite: 100_000_000,
  pointRatio: 1.4,
  ucb95: 1.55,
  lcb95: 1.4,
  state: "FAIL"
};

/** CI straddles 1.25 (ucb95 > 1.25, lcb95 <= 1.25) -> INCONCLUSIVE, per the brief's Step-1 case. */
const INCONCLUSIVE_RATIO: RatioVerdict = {
  p95Kernel: 130_000_000,
  p95Sqlite: 100_000_000,
  pointRatio: 1.3,
  ucb95: 1.32,
  lcb95: 1.1,
  state: "INCONCLUSIVE"
};

function makeMemoryVerdict(arm: "kernel" | "sqlite", state: RatioVerdictState): MemoryVerdict {
  return {
    arm,
    medium: 260_000_000,
    big1k: 380_000_000,
    baseline: 200_000_000,
    absoluteCapPass: state !== "FAIL",
    growthAdjusted: state === "FAIL" ? 10 : 3,
    growthPass: state !== "FAIL",
    state
  };
}

const PASS_MEMORY = { kernel: makeMemoryVerdict("kernel", "PASS"), sqlite: makeMemoryVerdict("sqlite", "PASS") };
const OK_LIFECYCLE = { kernel: 4, sqlite: 4 };
const OK_TREND = { firstHalfP95Ratio: 1.1, lastHalfP95Ratio: 1.15 };

/** A corpus report whose ONLY non-PASS ingredient is `cold`/`warm` — isolates the ratio verdict as the thing driving corpusState in the PASS/FAIL/INCONCLUSIVE fixtures below. */
function makeCorpusReport(cold: RatioVerdict, warm: RatioVerdict): Gate3CorpusReport {
  return buildGate3CorpusReport({
    cold,
    warm,
    warmTrend: OK_TREND,
    memory: PASS_MEMORY,
    lifecycle: OK_LIFECYCLE
  });
}

const PASS_CORPUS = makeCorpusReport(PASS_RATIO, PASS_RATIO);
const FAIL_CORPUS = makeCorpusReport(PASS_RATIO, FAIL_RATIO);
const INCONCLUSIVE_CORPUS = makeCorpusReport(INCONCLUSIVE_RATIO, PASS_RATIO);

const FIXTURE_PROVENANCE: Provenance = {
  headSha: "a".repeat(40),
  dirty: false,
  harnessDigest: "b".repeat(64),
  daemonBinarySha: "c".repeat(64),
  os: "darwin 25.5.0",
  cpu: "Apple M-fixture",
  nodeVersion: "v22.15.0",
  rustVersion: "rustc 1.89.0",
  scheduleSeed: 42,
  timestamp: "2026-07-22T00:00:00.000Z"
};

function makeSample(arm: "kernel" | "sqlite", pairId: number, wallNs: number): Sample {
  const order: PairOrder = "AB";
  return {
    arm,
    corpus: "medium",
    mode: "cold",
    pairId,
    order,
    iteration: pairId,
    callerWallNs: wallNs,
    childMaxRssBytes: 50_000_000,
    published: true,
    childPid: 1000 + pairId
  };
}

function makePair(pairId: number, kernelWallNs: number, sqliteWallNs: number): SchedulePair {
  return {
    pairId,
    order: "AB",
    kernel: makeSample("kernel", pairId, kernelWallNs),
    sqlite: makeSample("sqlite", pairId, sqliteWallNs)
  };
}

// ---------------------------------------------------------------------------
// corpusState
// ---------------------------------------------------------------------------

describe("corpusState", () => {
  it("PASS corpus (ucb95 1.18, memory PASS, lifecycle 4/4) -> PASS", () => {
    expect(corpusState(PASS_CORPUS)).toBe("PASS");
  });

  it("FAIL corpus (warm lcb95 1.4 > 1.25) -> FAIL even though cold/memory are PASS", () => {
    expect(corpusState(FAIL_CORPUS)).toBe("FAIL");
  });

  it("INCONCLUSIVE corpus (cold CI straddles 1.25) -> INCONCLUSIVE", () => {
    expect(corpusState(INCONCLUSIVE_CORPUS)).toBe("INCONCLUSIVE");
  });

  it("a FAIL memory verdict alone (ratios PASS) still drives the corpus to FAIL", () => {
    const report = buildGate3CorpusReport({
      cold: PASS_RATIO,
      warm: PASS_RATIO,
      warmTrend: OK_TREND,
      memory: { kernel: makeMemoryVerdict("kernel", "FAIL"), sqlite: makeMemoryVerdict("sqlite", "PASS") },
      lifecycle: OK_LIFECYCLE
    });
    expect(corpusState(report)).toBe("FAIL");
  });

  it("lifecycle mismatch does NOT affect corpusState (excluded from the tri-state by design)", () => {
    const report = buildGate3CorpusReport({
      cold: PASS_RATIO,
      warm: PASS_RATIO,
      warmTrend: OK_TREND,
      memory: PASS_MEMORY,
      lifecycle: { kernel: 5, sqlite: 4 }
    });
    expect(corpusState(report)).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// buildGate3Report: precedence resolution + medium-only-never-PASS
// ---------------------------------------------------------------------------

describe("buildGate3Report: overall verdict precedence", () => {
  it("PASS + PASS -> PASS", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS, big1k: PASS_CORPUS });
    expect(report.verdict).toBe("PASS");
  });

  it("PASS + FAIL -> FAIL (any FAIL anywhere wins)", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS, big1k: FAIL_CORPUS });
    expect(report.verdict).toBe("FAIL");
  });

  it("FAIL + PASS -> FAIL (order doesn't matter)", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: FAIL_CORPUS, big1k: PASS_CORPUS });
    expect(report.verdict).toBe("FAIL");
  });

  it("PASS + INCONCLUSIVE -> INCONCLUSIVE (INCONCLUSIVE beats PASS absent a FAIL)", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS, big1k: INCONCLUSIVE_CORPUS });
    expect(report.verdict).toBe("INCONCLUSIVE");
  });

  it("FAIL + INCONCLUSIVE -> FAIL (FAIL beats INCONCLUSIVE)", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: FAIL_CORPUS, big1k: INCONCLUSIVE_CORPUS });
    expect(report.verdict).toBe("FAIL");
  });

  it("threads provenance through unchanged", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS, big1k: PASS_CORPUS });
    expect(report.provenance).toEqual(FIXTURE_PROVENANCE);
  });
});

describe("buildGate3Report: medium-only never PASS", () => {
  it("medium-only PASS corpus -> overall INCONCLUSIVE, never PASS", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.big1k).toBeUndefined();
  });

  it("medium-only FAIL corpus -> overall FAIL (not capped — a genuine finding)", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: FAIL_CORPUS });
    expect(report.verdict).toBe("FAIL");
  });

  it("medium-only INCONCLUSIVE corpus -> overall INCONCLUSIVE", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: INCONCLUSIVE_CORPUS });
    expect(report.verdict).toBe("INCONCLUSIVE");
  });
});

// ---------------------------------------------------------------------------
// Markdown banner: names the verdict + measured UCB/LCB literally
// ---------------------------------------------------------------------------

describe("renderGate3Markdown: verdict banner", () => {
  it("PASS banner literally names PASS and the decisive corpus's measured UCB (1.1800)", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS, big1k: PASS_CORPUS });
    const markdown = renderGate3Markdown(report);
    expect(markdown).toMatch(/## Verdict: PASS/);
    expect(markdown).toContain("1.1800");
  });

  it("FAIL banner literally names FAIL and the falsifying measured LCB (1.4000)", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS, big1k: FAIL_CORPUS });
    const markdown = renderGate3Markdown(report);
    expect(markdown).toMatch(/## Verdict: FAIL/);
    expect(markdown).toContain("1.4000");
  });

  it("INCONCLUSIVE banner literally names INCONCLUSIVE and its measured UCB (1.3200)", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS, big1k: INCONCLUSIVE_CORPUS });
    const markdown = renderGate3Markdown(report);
    expect(markdown).toMatch(/## Verdict: INCONCLUSIVE/);
    expect(markdown).toContain("1.3200");
  });

  it("a memory-only FAIL (no ratio candidate itself FAILs) renders an honest 'driven by memory verdict' banner, not a mislabeled LCB", () => {
    // Both cold/warm ratios PASS on both corpora; only the kernel memory
    // verdict is FAIL. corpusState's worst-of-four still drives this corpus
    // (and the overall report) to FAIL, but no cold/warm candidate is itself
    // FAIL, so the old fallback (`candidates[0]`) would have picked an
    // arbitrary PASSing ratio and mislabeled its lcb95 as "> 1.25".
    const memoryOnlyFailCorpus = buildGate3CorpusReport({
      cold: PASS_RATIO,
      warm: PASS_RATIO,
      warmTrend: OK_TREND,
      memory: { kernel: makeMemoryVerdict("kernel", "FAIL"), sqlite: makeMemoryVerdict("sqlite", "PASS") },
      lifecycle: OK_LIFECYCLE
    });
    expect(corpusState(memoryOnlyFailCorpus)).toBe("FAIL");

    const report = buildGate3Report(FIXTURE_PROVENANCE, {
      medium: memoryOnlyFailCorpus,
      big1k: PASS_CORPUS
    });
    expect(report.verdict).toBe("FAIL");

    const markdown = renderGate3Markdown(report);
    expect(markdown).toMatch(/## Verdict: FAIL/);
    expect(markdown).toContain("driven by memory verdict");
    // The mislabeled form the bug produced: rendering some unrelated PASSing
    // ratio's lcb95 dressed up as the ">1.25" falsifier.
    expect(markdown).not.toContain("> 1.25");
  });

  it("includes provenance fields and both corpora's rows", () => {
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS, big1k: PASS_CORPUS });
    const markdown = renderGate3Markdown(report);
    expect(markdown).toContain(FIXTURE_PROVENANCE.headSha);
    expect(markdown).toContain(FIXTURE_PROVENANCE.harnessDigest);
    expect(markdown).toContain(FIXTURE_PROVENANCE.daemonBinarySha);
    expect(markdown).toContain("### medium");
    expect(markdown).toContain("### big1k");
  });
});

// ---------------------------------------------------------------------------
// writeGate3Artifacts
// ---------------------------------------------------------------------------

describe("writeGate3Artifacts", () => {
  let outDir: string;

  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("writes JSON (full report incl. raw samples + provenance) and Markdown, both existing on disk", () => {
    outDir = mkdtempSync(join(tmpdir(), "strata-gate3-report-"));
    const corpusWithSamples: Gate3CorpusReport = {
      ...PASS_CORPUS,
      coldPairs: [makePair(0, 118_000_000, 100_000_000), makePair(1, 120_000_000, 101_000_000)],
      warmPairs: [makePair(0, 117_000_000, 99_000_000)]
    };
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: corpusWithSamples, big1k: PASS_CORPUS });

    const { jsonPath, markdownPath } = writeGate3Artifacts(report, outDir, { deterministicName: true });

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);
    expect(jsonPath.endsWith("gate3-noninferiority-profile.json")).toBe(true);
    expect(markdownPath.endsWith("gate3-noninferiority-profile.md")).toBe(true);

    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as typeof report;
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.provenance).toEqual(FIXTURE_PROVENANCE);
    // Raw samples retained verbatim, not summarized away.
    expect(parsed.medium.coldPairs).toHaveLength(2);
    expect(parsed.medium.coldPairs?.[0]?.kernel.callerWallNs).toBe(118_000_000);
    expect(parsed.medium.warmPairs).toHaveLength(1);

    const markdown = readFileSync(markdownPath, "utf8");
    expect(markdown).toContain("## Verdict: PASS");
  });

  it("non-deterministic name defaults to a timestamped gate3-profile-*.{json,md} pair", () => {
    outDir = mkdtempSync(join(tmpdir(), "strata-gate3-report-"));
    const report = buildGate3Report(FIXTURE_PROVENANCE, { medium: PASS_CORPUS });
    const { jsonPath, markdownPath } = writeGate3Artifacts(report, outDir);
    expect(jsonPath).toMatch(/gate3-profile-.*\.json$/);
    expect(markdownPath).toMatch(/gate3-profile-.*\.md$/);
  });
});

// ---------------------------------------------------------------------------
// collectProvenance: one REAL, unmocked smoke assertion (cheap, foreground).
// ---------------------------------------------------------------------------

describe("collectProvenance (real, unmocked)", () => {
  it("returns non-empty, well-shaped fields against the actual repo/build state", () => {
    const provenance = collectProvenance({ scheduleSeed: 7, timestamp: "2026-07-22T00:00:00.000Z" });

    expect(provenance.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof provenance.dirty).toBe("boolean");
    expect(provenance.harnessDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.daemonBinarySha).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.os.length).toBeGreaterThan(0);
    expect(provenance.cpu.length).toBeGreaterThan(0);
    expect(provenance.nodeVersion).toMatch(/^v\d+\./);
    expect(provenance.rustVersion.toLowerCase()).toContain("rustc");
    expect(provenance.scheduleSeed).toBe(7);
    expect(provenance.timestamp).toBe("2026-07-22T00:00:00.000Z");
  });
});
