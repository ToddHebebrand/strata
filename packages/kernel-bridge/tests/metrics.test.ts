import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StageRecorder } from "../src/metrics";
import { bridgeResponseSchema } from "../src/protocol";

const errorResponseFixturePath = fileURLToPath(
  new URL("fixtures/protocol-v1/error-response.json", import.meta.url)
);

function errorResponseFixture(): unknown {
  return JSON.parse(readFileSync(errorResponseFixturePath, "utf8"));
}

describe("StageRecorder", () => {
  it("accumulates per-stage nanoseconds and reports peak RSS in bytes", () => {
    const recorder = new StageRecorder();
    const value = recorder.time("hydrate", () => {
      let sink = 0;
      for (let index = 0; index < 100_000; index += 1) sink += index;
      return sink;
    });
    expect(value).toBeGreaterThan(0);
    const metrics = recorder.finish();
    expect(metrics.hydrateNs).toBeGreaterThan(0);
    expect(metrics.totalNs).toBeGreaterThanOrEqual(metrics.hydrateNs!);
    expect(metrics.peakRssBytes).toBeGreaterThan(0);
    expect(metrics.peakRssBytes % 1024).toBe(0); // KiB → bytes conversion
    expect(metrics.analyzeNs).toBeUndefined();
  });

  it("records a stage even when the bracketed function throws", () => {
    const recorder = new StageRecorder();
    expect(() =>
      recorder.time("validate", () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(recorder.finish().validateNs).toBeGreaterThan(0);
  });
});

describe("bridge response metrics field", () => {
  it("accepts absent metrics, valid metrics, and rejects unknown members", () => {
    const base = errorResponseFixture() as Record<string, unknown>;

    expect(() => bridgeResponseSchema.parse(base)).not.toThrow();
    expect(() =>
      bridgeResponseSchema.parse({
        ...base,
        metrics: { totalNs: 5, peakRssBytes: 1024, hydrateNs: 3 }
      })
    ).not.toThrow();
    expect(() =>
      bridgeResponseSchema.parse({
        ...base,
        metrics: { totalNs: 5, peakRssBytes: 1024, bogus: 1 }
      })
    ).toThrow();
  });
});
