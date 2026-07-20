// Gate 2 of the iteration-6 slice-A convergence frame: the live acceptance
// oracle for key-free per-stage observability. This is the FIRST end-to-end
// exercise of the whole instrumented kernel-arm T03 flow — cold start through
// publish, then restart/replay — with the daemon's `--metrics` sink enabled on
// both legs, aggregated into one `Gate2Profile`. The eight numbered categories
// below, the phase-coverage assertion, the all-`ok` outcome assertion, and the
// cross-invariants are the acceptance content; a failure here is a finding
// about the stack, not a threshold to soften. No model calls, no API keys, no
// persisted SQLite. See
// docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md.
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { runGate2KernelFlow, writeGate2Artifacts } from "../src/gate2.js";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("gate 2: per-stage observability profile (key-free)", () => {
  it("produces a complete, internally consistent kernel-arm T03 profile", async () => {
    const { records, profile } = await runGate2KernelFlow(join(repoRoot, "examples/medium"));

    // 1. Per-stage wall time
    const submit = profile.requests.find((request) => request.action === "submit_change_set")!;
    const advances = profile.requests.filter((request) => request.action === "advance_change_set");
    expect(submit.wallNs).toBeGreaterThan(0);
    expect(advances.length).toBeGreaterThan(0);
    for (const advance of advances) expect(advance.wallNs).toBeGreaterThan(0);

    // 2. Peak memory (daemon + worker)
    expect(profile.totals.daemonPeakRssBytes).toBeGreaterThan(1024 * 1024);
    expect(profile.totals.maxWorkerPeakRssBytes).toBeGreaterThan(1024 * 1024);

    // 3. Serialized snapshot bytes: seed, per-worker request (snapshot vs total), recovery
    expect(profile.seed.snapshotBytes).toBeGreaterThan(0);
    for (const run of profile.workerRuns) {
      expect(run.snapshotBytes).toBeGreaterThan(0);
      expect(run.totalRequestBytes).toBeGreaterThanOrEqual(run.snapshotBytes);
    }
    expect(profile.recovery.restart.snapshotBytes).toBeGreaterThan(0);

    // 4. Node-worker starts, phase-attributed, all clean
    expect(profile.totals.workerStarts).toBe(profile.workerRuns.length);
    for (const run of profile.workerRuns) expect(run.outcome).toBe("ok");
    const phases = new Set(profile.workerRuns.map((run) => run.phase));
    for (const phase of ["submitAnalysis", "claimAnalysis", "preCandidateAnalysis", "postCandidateAnalysis", "candidate"]) {
      expect(phases).toContain(phase);
    }

    // 5. SQLite hydration time (inside the worker)
    for (const run of profile.workerRuns) expect(run.worker!.hydrateNs).toBeGreaterThan(0);

    // 6. Validation time (candidate tsc gate)
    const candidate = profile.workerRuns.find((run) => run.phase === "candidate")!;
    expect(candidate.worker!.validateNs).toBeGreaterThan(0);

    // 7. redb publication time (+ honestly-scoped record bytes)
    expect(profile.publication.persistenceNs).toBeGreaterThan(0);
    expect(profile.publication.memoryPublishNs).toBeGreaterThanOrEqual(0);
    expect(profile.publication.preCandidateAnalysisNs).toBeGreaterThan(0);
    expect(profile.publication.postCandidateAnalysisNs).toBeGreaterThan(0);
    expect(profile.publication.candidateNs).toBeGreaterThan(0);
    expect(profile.publication.coreGraphRecordValueBytes).toBeGreaterThan(0);

    // 8. Restart replay time
    expect(profile.recovery.cold.recovered).toBe(false);
    expect(profile.recovery.cold.seedNs).toBeGreaterThan(0);
    expect(profile.recovery.restart.recovered).toBe(true);
    expect(profile.recovery.restart.replayedOperations).toBe(1);
    expect(profile.recovery.restart.replayNs).toBeGreaterThan(0);

    // Cross-invariants
    for (const run of profile.workerRuns) {
      if (run.worker !== null) expect(run.bridgeWallNs).toBeGreaterThanOrEqual(run.worker.totalNs);
    }
    const publishingAdvanceWall = Math.max(...advances.map((advance) => advance.wallNs));
    expect(publishingAdvanceWall).toBeGreaterThanOrEqual(profile.publication.persistenceNs);
    expect(profile.publication.candidateNs).toBeGreaterThanOrEqual(candidate.bridgeWallNs);

    const artifacts = writeGate2Artifacts(profile, records, join(repoRoot, "packages/live-compare/results"));
    expect(artifacts.jsonPath).toContain("gate2-profile-");
  }, 300_000);
});
