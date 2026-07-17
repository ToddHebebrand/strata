import type { ArtifactRun } from "./artifacts.js";
import type { RoundPlan } from "./runner.js";
import type { TeamAccounting } from "./runner.js";
import type { ScheduledTrial } from "./schedule.js";

export interface ArmExecutionResult {
  accounting: TeamAccounting;
  /** Full verification.json payload, or null if the arm died before the verifier ran. */
  verification: Record<string, unknown> | null;
  /** Strata arm only: the canonical-audit.json payload. */
  canonicalAudit?: Record<string, unknown>;
  /** Bounded evidence snapshots (relative path → content). */
  evidence?: Record<string, string>;
}

export type ArmExecutor = (entry: ScheduledTrial) => Promise<ArmExecutionResult>;

export interface ComparisonRoundDeps {
  plan: RoundPlan;
  artifacts: ArtifactRun;
  executeStrataArm: ArmExecutor;
  executeBaselineArm: ArmExecutor;
}

export interface RoundOutcome {
  completedTrials: number;
  completedArms: number;
  totalCostUsd: number;
  failures: number;
  stopped: null | "round_maximum_reached" | "dispositive_failure";
}

/**
 * Drives one comparison round deterministically over the frozen schedule.
 * Arms run sequentially per the trial's pre-registered order; the round stops
 * before consuming another arm's sessions once accumulated reported cost
 * reaches the approved projected maximum, and immediately after any
 * dispositive failure — in both cases only after evidence is flushed and the
 * run is finalized.
 */
export async function runComparisonRound(deps: ComparisonRoundDeps): Promise<RoundOutcome> {
  let totalCostUsd = 0;
  let failures = 0;
  let completedTrials = 0;
  let completedArms = 0;
  let stopped: RoundOutcome["stopped"] = null;

  const finalize = (): void => {
    deps.artifacts.finalize({
      schemaVersion: 1,
      trialsRecorded: completedTrials,
      sessionsRecorded: completedArms,
      totalCostUsd,
      failures,
      generatedFrom: "finalized trial records"
    });
  };

  for (const entry of deps.plan.schedule.entries) {
    const arms: ["strata" | "baseline", ArmExecutor][] =
      entry.armOrder === "strata-first"
        ? [["strata", deps.executeStrataArm], ["baseline", deps.executeBaselineArm]]
        : [["baseline", deps.executeBaselineArm], ["strata", deps.executeStrataArm]];

    let trialComplete = true;
    for (const [arm, execute] of arms) {
      if (totalCostUsd >= deps.plan.projectedMaxUsd) {
        stopped = "round_maximum_reached";
        trialComplete = false;
        break;
      }
      const result = await execute(entry);
      completedArms += 1;
      totalCostUsd += result.accounting.totalAgentCostUsd;
      if (result.accounting.status === "failed") failures += 1;

      deps.artifacts.write(
        "team",
        {
          schemaVersion: 1,
          trialId: entry.trialId,
          arm,
          status: result.accounting.status,
          makespanMs: result.accounting.makespanMs,
          totalAgentCostUsd: result.accounting.totalAgentCostUsd,
          failures: Object.keys(result.accounting.taxonomyCounts),
          timeouts: Object.keys(result.accounting.taxonomyCounts).filter((value) =>
            value.endsWith("timeout")
          )
        },
        { trialId: entry.trialId, arm }
      );
      if (result.verification) {
        deps.artifacts.write("verification", result.verification, { trialId: entry.trialId, arm });
      }
      if (result.canonicalAudit) {
        deps.artifacts.write("canonical-audit", result.canonicalAudit, { trialId: entry.trialId, arm });
      }
      for (const [relativePath, content] of Object.entries(result.evidence ?? {})) {
        deps.artifacts.writeEvidence({ trialId: entry.trialId, arm }, relativePath, content);
      }

      if (result.accounting.dispositiveStop) {
        stopped = "dispositive_failure";
        trialComplete = false;
        break;
      }
    }
    if (trialComplete) completedTrials += 1;
    if (stopped) break;
  }

  finalize();
  return { completedTrials, completedArms, totalCostUsd, failures, stopped };
}
