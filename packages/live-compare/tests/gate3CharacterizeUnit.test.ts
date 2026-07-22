// Gate 3 (unkeyed noninferiority), Task 5 fix-report: unit coverage the
// reviewer's Important finding called out as missing — the throw-on-bleed
// window validation (`bindIterationWindow`, extracted from
// `characterizeKernelServer`'s inline loop body) had zero test coverage.
// `bindIterationWindow` is pure and synchronous (no I/O, no daemon), so it
// is exercised here directly against synthetic `MetricsRecord` arrays — no
// `strata-kernel-service` involved, fast.
import { describe, expect, it } from "vitest";
import { bindIterationWindow } from "../src/gate3/characterize.js";
import type { MetricsRecord, RequestRecord } from "../src/gate2.js";

let nextSeq = 0;

/** Minimal, fully-typed synthetic `RequestRecord`. */
function requestRecord(overrides: Partial<RequestRecord> & { action: string }): RequestRecord {
  return {
    kind: "request",
    action: overrides.action,
    wallNs: overrides.wallNs ?? 1_000,
    daemonPeakRssBytes: overrides.daemonPeakRssBytes ?? 10_000_000,
    workerStartsTotal: overrides.workerStartsTotal ?? 1,
    publication: overrides.publication ?? null,
    seq: overrides.seq ?? nextSeq++
  };
}

const PUBLICATION = {
  generation: 1,
  preCandidateAnalysisNs: 1,
  postCandidateAnalysisNs: 1,
  candidateNs: 1,
  persistenceNs: 1,
  memoryPublishNs: 1,
  coreGraphRecordValueBytes: 1,
  alreadyPublished: false
};

/** One clean iteration's worth of records: begin, add_intent, submit, a publishing advance. */
function cleanIterationRecords(submitWallNs: number, advanceWallNs: number): MetricsRecord[] {
  return [
    requestRecord({ action: "begin_change_set" }),
    requestRecord({ action: "add_intent" }),
    requestRecord({ action: "submit_change_set", wallNs: submitWallNs }),
    requestRecord({ action: "advance_change_set", wallNs: advanceWallNs, publication: PUBLICATION })
  ];
}

describe("bindIterationWindow", () => {
  it("clean window (1 submit + 1 publishing advance) binds and returns the exact records", () => {
    const records = cleanIterationRecords(111, 222);
    const binding = bindIterationWindow(records, 0, 0);

    expect(binding.submitRecord.action).toBe("submit_change_set");
    expect(binding.submitRecord.wallNs).toBe(111);
    expect(binding.advanceRecord.action).toBe("advance_change_set");
    expect(binding.advanceRecord.wallNs).toBe(222);
    expect(binding.advanceRecord.publication).not.toBeNull();
    expect(binding.newOffset).toBe(records.length);
    expect(binding.newRecords).toHaveLength(records.length);
  });

  it("only inspects records after priorOffset — an earlier iteration's records never bleed in", () => {
    // Two back-to-back clean iterations concatenated into one accumulating
    // array, exactly as the real metrics JSONL accumulates. Binding the
    // SECOND iteration with priorOffset = first.length must see only the
    // second iteration's submit/advance, not the first's.
    const first = cleanIterationRecords(111, 222);
    const second = cleanIterationRecords(333, 444);
    const all = [...first, ...second];

    const secondBinding = bindIterationWindow(all, first.length, 1);

    expect(secondBinding.submitRecord.wallNs).toBe(333);
    expect(secondBinding.advanceRecord.wallNs).toBe(444);
    expect(secondBinding.newOffset).toBe(all.length);
  });

  it("a non-publishing (still-polling) advance_change_set record is ignored, not counted as the publishing one", () => {
    const records: MetricsRecord[] = [
      requestRecord({ action: "submit_change_set", wallNs: 111 }),
      // Polling attempt: state not yet published, publication null.
      requestRecord({ action: "advance_change_set", wallNs: 50, publication: null }),
      requestRecord({ action: "advance_change_set", wallNs: 222, publication: PUBLICATION })
    ];

    const binding = bindIterationWindow(records, 0, 0);

    expect(binding.advanceRecord.wallNs).toBe(222);
  });

  it("throws on a 0-submit window (no submit_change_set record at all)", () => {
    const records: MetricsRecord[] = [
      requestRecord({ action: "advance_change_set", wallNs: 222, publication: PUBLICATION })
    ];

    expect(() => bindIterationWindow(records, 0, 3)).toThrow(
      /iteration 3 bound 0 submit_change_set metrics record\(s\) \(expected exactly 1\)/
    );
  });

  it("throws on a 2-submit window (cross-iteration bleed: two submits in one window)", () => {
    const records: MetricsRecord[] = [
      requestRecord({ action: "submit_change_set", wallNs: 111 }),
      requestRecord({ action: "submit_change_set", wallNs: 333 }),
      requestRecord({ action: "advance_change_set", wallNs: 222, publication: PUBLICATION })
    ];

    expect(() => bindIterationWindow(records, 0, 5)).toThrow(
      /iteration 5 bound 2 submit_change_set metrics record\(s\) \(expected exactly 1\)/
    );
  });

  it("throws when the window has an advance_change_set record but none of them is the publishing one", () => {
    const records: MetricsRecord[] = [
      requestRecord({ action: "submit_change_set", wallNs: 111 }),
      // Only non-publishing (still-polling) advances in this window.
      requestRecord({ action: "advance_change_set", wallNs: 50, publication: null }),
      requestRecord({ action: "advance_change_set", wallNs: 60, publication: null })
    ];

    expect(() => bindIterationWindow(records, 0, 7)).toThrow(
      /iteration 7 bound 0 publishing advance_change_set metrics record\(s\) \(expected exactly 1\)/
    );
  });

  it("throws on a 2-publishing-advance window", () => {
    const records: MetricsRecord[] = [
      requestRecord({ action: "submit_change_set", wallNs: 111 }),
      requestRecord({ action: "advance_change_set", wallNs: 222, publication: PUBLICATION }),
      requestRecord({ action: "advance_change_set", wallNs: 333, publication: PUBLICATION })
    ];

    expect(() => bindIterationWindow(records, 0, 9)).toThrow(
      /iteration 9 bound 2 publishing advance_change_set metrics record\(s\) \(expected exactly 1\)/
    );
  });

  it("error message reports the exact offset window", () => {
    // 4 filler records (a prior iteration, ignored by priorOffset=4) plus
    // one new record in this iteration's window — the window is [4, 5).
    const filler = cleanIterationRecords(1, 2);
    const records: MetricsRecord[] = [
      ...filler,
      requestRecord({ action: "advance_change_set", wallNs: 222, publication: PUBLICATION })
    ];

    expect(() => bindIterationWindow(records, 4, 0)).toThrow(/offset window \[4, 5\)/);
  });
});
