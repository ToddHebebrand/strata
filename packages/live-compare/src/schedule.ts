import { createHash } from "node:crypto";
import type { Phase6PacketId } from "./tasks.js";

export type ArmOrder = "strata-first" | "baseline-first";

export interface ScheduledTrial {
  trialId: string;
  scenario: Phase6PacketId;
  repetition: number;
  armOrder: ArmOrder;
  /** Stable per-scenario mapping of task assignments to launch processes. */
  taskProcessMapping: { "agent-1": "process-1" | "process-2"; "agent-2": "process-1" | "process-2" };
  /** Both task sessions in an arm are released concurrently behind one barrier. */
  concurrentTaskRelease: true;
}

export interface ExperimentSchedule {
  seed: string;
  trialsPerScenario: number;
  scenarios: readonly Phase6PacketId[];
  entries: readonly ScheduledTrial[];
}

const SCENARIOS: readonly Phase6PacketId[] = ["D", "M", "R", "S", "X", "G"];

/** Deterministic PRNG seeded from an arbitrary string (sha256 → mulberry32). */
function seededRandom(seed: string): () => number {
  const digest = createHash("sha256").update(seed).digest();
  let state = digest.readUInt32LE(0) ^ digest.readUInt32LE(4) ^ digest.readUInt32LE(8);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

export function createSchedule(params: {
  seed: string;
  trialsPerScenario: number;
}): ExperimentSchedule {
  if (!params.seed) throw new Error("schedule seed is required");
  if (!Number.isSafeInteger(params.trialsPerScenario) || params.trialsPerScenario < 1) {
    throw new Error("trialsPerScenario must be a positive integer");
  }

  const pilotArmRandom = seededRandom(`${params.seed}:pilot-arm-order`);
  const pilotOrders = shuffled(
    [
      "strata-first", "strata-first", "strata-first",
      "baseline-first", "baseline-first", "baseline-first"
    ] as ArmOrder[],
    pilotArmRandom
  );
  const pilotOrderByScenario = new Map<Phase6PacketId, ArmOrder>(
    SCENARIOS.map((scenario, index) => [scenario, pilotOrders[index]!])
  );

  const mappingRandom = seededRandom(`${params.seed}:task-process-mapping`);
  const mappingByScenario = new Map<Phase6PacketId, ScheduledTrial["taskProcessMapping"]>(
    SCENARIOS.map((scenario) => {
      const flipped = mappingRandom() < 0.5;
      return [scenario, {
        "agent-1": flipped ? "process-2" : "process-1",
        "agent-2": flipped ? "process-1" : "process-2"
      }];
    })
  );

  const entries: ScheduledTrial[] = [];
  for (let repetition = 1; repetition <= params.trialsPerScenario; repetition += 1) {
    const orderRandom = seededRandom(`${params.seed}:scenario-order:${repetition}`);
    for (const scenario of shuffled(SCENARIOS, orderRandom)) {
      const pilot = pilotOrderByScenario.get(scenario)!;
      const alternated: ArmOrder = repetition % 2 === 1
        ? pilot
        : pilot === "strata-first" ? "baseline-first" : "strata-first";
      entries.push(Object.freeze({
        trialId: `${scenario}-r${repetition}`,
        scenario,
        repetition,
        armOrder: alternated,
        taskProcessMapping: Object.freeze({ ...mappingByScenario.get(scenario)! }),
        concurrentTaskRelease: true as const
      }));
    }
  }

  return Object.freeze({
    seed: params.seed,
    trialsPerScenario: params.trialsPerScenario,
    scenarios: Object.freeze([...SCENARIOS]),
    entries: Object.freeze(entries)
  });
}
