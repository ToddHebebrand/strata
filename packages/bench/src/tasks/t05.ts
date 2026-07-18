import { T05_PROMPT } from "@strata-code/agent";
import { runBaselineTaskTrial } from "../configs/baseline";
import { runSubstrateTaskTrial } from "../configs/substrate";
import type { BenchTask } from "./index";

export const t05: BenchTask = {
  id: "T05",
  prompt: T05_PROMPT,
  substrate: (params) => runSubstrateTaskTrial("T05", params),
  baseline: (params) => runBaselineTaskTrial("T05", params)
};
