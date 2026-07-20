import type { WorkerStageMetrics } from "./protocol";

export type StageName = "hydrate" | "analyze" | "mutate" | "validate" | "export";

const STAGE_KEYS: Record<StageName, keyof WorkerStageMetrics> = {
  hydrate: "hydrateNs",
  analyze: "analyzeNs",
  mutate: "mutateNs",
  validate: "validateNs",
  export: "exportNs"
};

const WORKER_STARTED = process.hrtime.bigint();

/**
 * Accumulates per-stage wall-clock time for one worker invocation. Purely
 * observational: constructing and calling this never changes control flow,
 * error paths, or thrown values — `time()` re-throws whatever the bracketed
 * function throws, after recording the elapsed time for that stage.
 *
 * `process.resourceUsage()` (peak RSS) is read only inside `finish()`, so a
 * recorder that is constructed but never finished (e.g. the worker exits via
 * an unrelated path) costs nothing beyond the per-stage `hrtime` calls.
 */
export class StageRecorder {
  private readonly stageNs = new Map<StageName, bigint>();

  time<T>(stage: StageName, fn: () => T): T {
    const start = process.hrtime.bigint();
    try {
      return fn();
    } finally {
      const elapsed = process.hrtime.bigint() - start;
      this.stageNs.set(stage, (this.stageNs.get(stage) ?? 0n) + elapsed);
    }
  }

  finish(): WorkerStageMetrics {
    const metrics: WorkerStageMetrics = {
      totalNs: Number(process.hrtime.bigint() - WORKER_STARTED),
      // Node's resourceUsage().maxRSS is reported in KiB on all platforms.
      peakRssBytes: process.resourceUsage().maxRSS * 1024
    };
    for (const [stage, key] of Object.entries(STAGE_KEYS) as [
      StageName,
      keyof WorkerStageMetrics
    ][]) {
      const elapsed = this.stageNs.get(stage);
      if (elapsed !== undefined) {
        metrics[key] = Number(elapsed);
      }
    }
    return metrics;
  }
}
