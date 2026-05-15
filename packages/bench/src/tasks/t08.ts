import { T08_PROMPT } from "@strata/agent";
import { runBaselineTaskTrial } from "../configs/baseline";
import { runSubstrateTaskTrial } from "../configs/substrate";
import type { BenchTask } from "./index";

export const t08: BenchTask = {
  id: "T08",
  prompt: T08_PROMPT,
  substrate: (params) => runSubstrateTaskTrial("T08", params),
  baseline: (params) => runBaselineTaskTrial("T08", params)
};
