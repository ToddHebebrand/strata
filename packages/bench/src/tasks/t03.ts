import { T03_PROMPT } from "@strata-code/agent";
import { runBaselineTrial } from "../configs/baseline";
import { runSubstrateTrial } from "../configs/substrate";
import type { BenchTask } from "./index";

export const t03: BenchTask = {
  id: "T03",
  prompt: T03_PROMPT,
  substrate: (params) => runSubstrateTrial(params),
  baseline: (params) => runBaselineTrial(params)
};
