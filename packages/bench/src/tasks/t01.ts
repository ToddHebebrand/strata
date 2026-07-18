import { T01_PROMPT } from "@strata-code/agent";
import { runBaselineTaskTrial } from "../configs/baseline";
import { runSubstrateTaskTrial } from "../configs/substrate";
import type { BenchTask } from "./index";

export const t01: BenchTask = {
  id: "T01",
  prompt: T01_PROMPT,
  substrate: (params) => runSubstrateTaskTrial("T01", params),
  baseline: (params) => runBaselineTaskTrial("T01", params)
};
