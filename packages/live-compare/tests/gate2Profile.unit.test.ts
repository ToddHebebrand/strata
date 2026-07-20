// Pure unit coverage for gate 2's metrics parser/profile builder (Task 6).
// No daemon, no sockets — a hand-written JSONL fixture using the shared
// vocabulary values from docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md.
import { describe, expect, it } from "vitest";
import { buildGate2Profile, parseMetricsJsonl } from "../src/gate2.js";

/** One of each record kind, in the order a real cold+restart run would produce them. */
function validJsonl(): string {
  const lines = [
    {
      kind: "recovery",
      recovered: false,
      openNs: 1_200_000,
      replayNs: 0,
      seedNs: 900_000,
      replayedOperations: 0,
      snapshotGeneration: 0,
      generation: 0,
      snapshotBytes: 4096,
      seq: 0
    },
    {
      kind: "workerRun",
      requestKind: "analyzeIntent",
      changeSetId: "cs-1",
      phase: "submitAnalysis",
      outcome: "ok",
      bridgeWallNs: 5_000_000,
      snapshotBytes: 2048,
      totalRequestBytes: 2200,
      snapshotBuildNs: 10_000,
      requestSerializeNs: 20_000,
      responseBytes: 512,
      worker: {
        hydrateNs: 1_000_000,
        analyzeNs: 500_000,
        totalNs: 1_600_000,
        peakRssBytes: 41_943_040
      },
      seq: 1
    },
    {
      kind: "workerRun",
      requestKind: "buildValidateCandidate",
      changeSetId: "cs-1",
      phase: "candidate",
      outcome: "ok",
      bridgeWallNs: 8_000_000,
      snapshotBytes: 2048,
      totalRequestBytes: 2300,
      snapshotBuildNs: 12_000,
      requestSerializeNs: 25_000,
      responseBytes: 640,
      worker: {
        hydrateNs: 1_100_000,
        mutateNs: 200_000,
        validateNs: 4_000_000,
        exportNs: 300_000,
        totalNs: 6_500_000,
        peakRssBytes: 52_428_800
      },
      seq: 2
    },
    {
      kind: "request",
      action: "submit_change_set",
      wallNs: 12_000_000,
      daemonPeakRssBytes: 30_000_000,
      workerStartsTotal: 1,
      publication: null,
      seq: 3
    },
    {
      kind: "request",
      action: "advance_change_set",
      wallNs: 25_000_000,
      daemonPeakRssBytes: 31_000_000,
      workerStartsTotal: 2,
      publication: {
        generation: 1,
        preCandidateAnalysisNs: 2_000_000,
        postCandidateAnalysisNs: 1_000_000,
        candidateNs: 8_000_000,
        persistenceNs: 3_000_000,
        memoryPublishNs: 100_000,
        coreGraphRecordValueBytes: 1024,
        alreadyPublished: false
      },
      seq: 4
    },
    {
      kind: "recovery",
      recovered: true,
      openNs: 2_000_000,
      replayNs: 1_500_000,
      seedNs: 0,
      replayedOperations: 1,
      snapshotGeneration: 1,
      generation: 1,
      snapshotBytes: 4200,
      seq: 5
    }
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("parseMetricsJsonl", () => {
  it("parses one of each record kind", () => {
    const records = parseMetricsJsonl(validJsonl());
    expect(records).toHaveLength(6);
    expect(records[0]!.kind).toBe("recovery");
    expect(records[1]!.kind).toBe("workerRun");
    expect(records[3]!.kind).toBe("request");
  });

  it("ignores blank lines", () => {
    const records = parseMetricsJsonl(`\n${validJsonl()}\n\n`);
    expect(records).toHaveLength(6);
  });

  it("throws on a malformed line (invalid JSON)", () => {
    expect(() => parseMetricsJsonl("not json\n")).toThrow();
  });

  it("throws on an unknown record kind", () => {
    expect(() => parseMetricsJsonl('{"kind":"bogus","seq":0}\n')).toThrow();
  });
});

describe("buildGate2Profile", () => {
  it("builds a field-by-field profile from a valid record set", () => {
    const records = parseMetricsJsonl(validJsonl());
    const profile = buildGate2Profile(records);

    expect(profile.seed).toEqual({ snapshotBytes: 4096, seedNs: 900_000 });

    expect(profile.requests).toEqual([
      { action: "submit_change_set", wallNs: 12_000_000, daemonPeakRssBytes: 30_000_000 },
      { action: "advance_change_set", wallNs: 25_000_000, daemonPeakRssBytes: 31_000_000 }
    ]);

    expect(profile.workerRuns).toHaveLength(2);
    expect(profile.workerRuns[0]).toMatchObject({
      requestKind: "analyzeIntent",
      changeSetId: "cs-1",
      phase: "submitAnalysis",
      outcome: "ok",
      bridgeWallNs: 5_000_000,
      snapshotBytes: 2048,
      totalRequestBytes: 2200,
      snapshotBuildNs: 10_000,
      requestSerializeNs: 20_000,
      responseBytes: 512
    });
    expect(profile.workerRuns[0]!.worker).toEqual({
      hydrateNs: 1_000_000,
      analyzeNs: 500_000,
      totalNs: 1_600_000,
      peakRssBytes: 41_943_040
    });
    expect(profile.workerRuns[1]!.phase).toBe("candidate");

    expect(profile.publication).toEqual({
      generation: 1,
      preCandidateAnalysisNs: 2_000_000,
      postCandidateAnalysisNs: 1_000_000,
      candidateNs: 8_000_000,
      persistenceNs: 3_000_000,
      memoryPublishNs: 100_000,
      coreGraphRecordValueBytes: 1024
    });

    expect(profile.recovery.cold).toEqual({
      recovered: false,
      openNs: 1_200_000,
      replayNs: 0,
      seedNs: 900_000,
      replayedOperations: 0,
      snapshotBytes: 4096
    });
    expect(profile.recovery.restart).toEqual({
      recovered: true,
      openNs: 2_000_000,
      replayNs: 1_500_000,
      seedNs: 0,
      replayedOperations: 1,
      snapshotBytes: 4200
    });

    expect(profile.totals).toEqual({
      workerStarts: 2,
      daemonPeakRssBytes: 31_000_000,
      maxWorkerPeakRssBytes: 52_428_800
    });
  });

  it("throws when there are two publications", () => {
    const records = parseMetricsJsonl(validJsonl());
    const extraPublication = { ...records[4]!, seq: 6 };
    expect(() => buildGate2Profile([...records, extraPublication])).toThrow();
  });

  it("throws when there is no publication", () => {
    const records = parseMetricsJsonl(validJsonl()).filter(
      (record) => !(record.kind === "request" && record.publication !== null)
    );
    expect(() => buildGate2Profile(records)).toThrow();
  });

  it("throws when the restart recovery record is missing", () => {
    const records = parseMetricsJsonl(validJsonl()).filter(
      (record) => !(record.kind === "recovery" && record.recovered)
    );
    expect(() => buildGate2Profile(records)).toThrow();
  });

  it("throws when the cold recovery record is missing", () => {
    const records = parseMetricsJsonl(validJsonl()).filter(
      (record) => !(record.kind === "recovery" && !record.recovered)
    );
    expect(() => buildGate2Profile(records)).toThrow();
  });

  it("throws when a leg's final workerStartsTotal exceeds its workerRun count", () => {
    // A spawned worker that produced no terminal record: the cold leg has two
    // workerRun records but its final request claims three spawns.
    const records = parseMetricsJsonl(validJsonl()).map((record) =>
      record.kind === "request" && record.action === "advance_change_set"
        ? { ...record, workerStartsTotal: 3 }
        : record
    );
    expect(() => buildGate2Profile(records)).toThrow(/spawn\/terminal mismatch/);
  });

  it("throws when a workerRun outcome is not ok", () => {
    const records = parseMetricsJsonl(validJsonl()).map((record) =>
      record.kind === "workerRun" && record.phase === "candidate"
        ? { ...record, outcome: "timedOut" as const, worker: null }
        : record
    );
    expect(() => buildGate2Profile(records)).toThrow();
  });
});
