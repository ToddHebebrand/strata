import type { TrialMetrics } from "../metrics";
import { t01 } from "./t01";
import { t03 } from "./t03";
import { t05 } from "./t05";
import { t08 } from "./t08";

export type BenchTaskId = "T01" | "T03" | "T05" | "T08";

export interface BenchTaskRunParams {
  trial: number;
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  keepArtifacts?: boolean;
}

export interface BenchTask {
  id: BenchTaskId;
  prompt: string;
  substrate(params: BenchTaskRunParams): Promise<TrialMetrics>;
  baseline(params: BenchTaskRunParams): Promise<TrialMetrics>;
}

export const BENCH_TASKS: Record<BenchTaskId, BenchTask> = {
  T01: t01,
  T03: t03,
  T05: t05,
  T08: t08
};

export const ALL_TASK_IDS: BenchTaskId[] = ["T01", "T03", "T05", "T08"];
