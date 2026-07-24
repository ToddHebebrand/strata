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
  private readonly startedAt: bigint;

  /**
   * `startedAt` anchors `finish().totalNs`. The default — worker process
   * start — is the one-shot transport's semantics, where process == request
   * so "since process start" IS the request's lifetime (module load and
   * stdin read included). The persistent loop passes the moment the request
   * frame was received instead, so each trip's total is that request's serve
   * duration rather than cumulative process uptime; one-shot callers pass
   * nothing and are byte-identical to before this parameter existed.
   */
  constructor(startedAt: bigint = WORKER_STARTED) {
    this.startedAt = startedAt;
  }

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
      totalNs: Number(process.hrtime.bigint() - this.startedAt),
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
