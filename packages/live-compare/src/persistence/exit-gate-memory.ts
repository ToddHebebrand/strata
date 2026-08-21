// Bridge-persistence slice, Task 11 (exit-gate harness surface): the two
// A3 memory-measurement drivers run-big.ts consumes in `--exit-gate
// persistence` mode. Everything here is ADDITIVE — nothing on the default
// gate-3 path imports this module.
//
//   runMediumLeakCheck       — the Task 9 N=12 medium warm leak check,
//                              extracted from persistenceMemory.test.ts's
//                              driving loop so the exit gate runs the SAME
//                              pre-registered protocol: fresh persistent-
//                              bridge daemon on examples/medium, 12
//                              alternating renames, post-publish + quiescence
//                              sampling, PID continuity throughout. A
//                              continuity violation is RETURNED (not thrown)
//                              so the exit gate can record INCONCLUSIVE with
//                              the reason instead of dying mid-run.
//
//   createWarmScheduleSampler — the big1k absolute-cap sampler: polls the OS
//                              process tree during the (untouched) big1k warm
//                              schedule — run-big -> kernel-child ->
//                              strata-kernel-service -> persistent worker —
//                              and takes continuity-checked combined-RSS
//                              samples via the Task 9 sampler. A worker
//                              respawn mid-schedule (daemon alive, worker PID
//                              changed/dead) is a continuity violation ->
//                              INCONCLUSIVE; whole-arm teardown at schedule
//                              end (daemon dead too) simply ends sampling.
//
// See docs/superpowers/plans/2026-07-23-bridge-persistence-slice.md, Task 11.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationClient } from "@strata-code/coordination-client";
import {
  ADVANCE_DEADLINE_MS,
  DISCOVERY_DEADLINE_MS,
  MAX_ADVANCE_ATTEMPTS,
  SUBMIT_DEADLINE_MS,
  TASK_PROMPT,
  credentialFreeEnv,
  expectResult,
  kernelServiceBinary
} from "../gate1.js";
import { startKernelService } from "../service.js";
import {
  MEDIUM_LEAK_ITERATIONS,
  PidContinuityViolation,
  createRssSampler,
  discoverChildPidByCommand,
  discoverPersistentWorkerPid,
  waitForPersistentWorkerPid,
  type GuardedPids,
  type RssSamplePoint,
  type RssSampler
} from "./memory-guard.js";

// ---------------------------------------------------------------------------
// Medium N=12 leak-check driver (the Task 9 protocol, exit-gate packaging).
// ---------------------------------------------------------------------------

export interface MediumLeakCheckOutcome {
  /** Per-iteration combined high-waters, in iteration order (< N=12 iff the run was cut short by a violation). */
  highWaterBytes: number[];
  /** The full retained sample series (2 per completed iteration). */
  samples: RssSamplePoint[];
  daemonPid: number;
  workerPid: number;
  /** False iff a PID death/respawn was observed mid-run. */
  continuityHeld: boolean;
  /** The violation message, when continuityHeld is false. */
  inconclusiveReason?: string;
}

/** One published rename through the coordination protocol (begin/add/submit/advance-until-published). */
async function publishRename(client: CoordinationClient, fromName: string, toName: string): Promise<void> {
  const discovery = expectResult(
    await client.findDeclarations(fromName, { kind: "interface" }, DISCOVERY_DEADLINE_MS),
    "declarations"
  );
  if (discovery.declarations.length !== 1) {
    throw new Error(
      `runMediumLeakCheck: expected exactly 1 interface named ${JSON.stringify(fromName)}, ` +
        `found ${discovery.declarations.length}`
    );
  }
  const begun = expectResult(await client.beginChangeSet(TASK_PROMPT, SUBMIT_DEADLINE_MS), "change_set");
  expectResult(
    await client.addIntent(
      begun.changeSetId,
      { type: "rename_symbol", declarationId: discovery.declarations[0]!.nodeId, newName: toName },
      SUBMIT_DEADLINE_MS
    ),
    "change_set"
  );
  expectResult(await client.submitChangeSet(begun.changeSetId, SUBMIT_DEADLINE_MS), "change_set");
  for (let attempt = 0; attempt < MAX_ADVANCE_ATTEMPTS; attempt += 1) {
    const advanced = expectResult(await client.advanceChangeSet(begun.changeSetId, ADVANCE_DEADLINE_MS), "change_set");
    if (advanced.state === "published" && advanced.operationId !== null) return;
  }
  throw new Error(`runMediumLeakCheck: rename ${fromName}->${toName} did not publish within ${MAX_ADVANCE_ATTEMPTS} advances`);
}

/**
 * Run the pre-registered Task 9 medium leak-check protocol: a fresh
 * `--persistent-bridge` daemon over `corpusRoot` (examples/medium), N=12
 * alternating User<->Account renames, the Task 9 sampler after each publish.
 * PID continuity violations are caught and reported in the outcome; every
 * other failure (a rename that will not publish, a daemon that will not
 * start) still throws — those are infra errors, not memory verdicts.
 */
export async function runMediumLeakCheck(corpusRoot: string): Promise<MediumLeakCheckOutcome> {
  const directory = mkdtempSync(join(tmpdir(), "strata-exit-gate-leak-"));
  const service = await startKernelService(corpusRoot, {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    directory,
    extraArgs: ["--persistent-bridge"]
  });
  try {
    const daemonPid = service.child.pid;
    if (!daemonPid) throw new Error("runMediumLeakCheck: daemon spawn returned no pid");
    const client = new CoordinationClient({
      socketPath: service.socketPath,
      clientId: `exit-gate-leak-check:${randomUUID()}`
    });
    await client.hello(DISCOVERY_DEADLINE_MS);
    const workerPid = await waitForPersistentWorkerPid(daemonPid, 30_000);
    const sampler = createRssSampler({ daemon: daemonPid, worker: workerPid });

    const highWaterBytes: number[] = [];
    let inconclusiveReason: string | undefined;
    for (let iteration = 0; iteration < MEDIUM_LEAK_ITERATIONS; iteration += 1) {
      const fromName = iteration % 2 === 0 ? "User" : "Account";
      const toName = iteration % 2 === 0 ? "Account" : "User";
      await publishRename(client, fromName, toName);
      try {
        const sampled = await sampler.sampleIteration(`iteration-${iteration + 1}`);
        highWaterBytes.push(sampled.highWaterBytes);
      } catch (error) {
        if (!(error instanceof PidContinuityViolation)) throw error;
        inconclusiveReason = `medium leak check: ${error.message}`;
        break;
      }
    }

    return {
      highWaterBytes,
      samples: [...sampler.samples()],
      daemonPid,
      workerPid,
      continuityHeld: sampler.continuityHeld() && inconclusiveReason === undefined,
      ...(inconclusiveReason !== undefined ? { inconclusiveReason } : {})
    };
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Big1k warm-schedule sampler (absolute-cap measurement, PID continuity).
// ---------------------------------------------------------------------------

export interface WarmScheduleSampling {
  /** Combined daemon+worker samples taken during the warm schedule, in order. */
  combinedBytes: number[];
  /** The full continuity-checked sample series. */
  samples: RssSamplePoint[];
  /** The discovered daemon+worker PIDs (absent iff discovery never completed). */
  pids?: GuardedPids;
  /** False iff a mid-schedule death/respawn was observed (daemon still alive). */
  continuityHeld: boolean;
  /** Why the sampling cannot support a verdict, when it cannot. */
  inconclusiveReason?: string;
}

export interface WarmScheduleSampler {
  /** Begin polling. Call immediately before the warm schedule starts. */
  start(): void;
  /** Stop polling and return everything sampled. Call immediately after the warm schedule returns. */
  stop(): WarmScheduleSampling;
}

/** True iff `pid` is currently signalable (alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll the process tree under `harnessPid` every `intervalMs`: first discover
 * kernel-child -> daemon -> persistent worker, then take one continuity-
 * checked combined-RSS sample per tick via the Task 9 sampler. A
 * `PidContinuityViolation` while the DAEMON is still alive is a genuine
 * mid-schedule worker respawn/death -> continuityHeld=false + reason; a
 * violation with the daemon dead too is whole-arm teardown at the end of the
 * schedule (kernel-child stops its service when its plan completes) and
 * simply ends sampling. Never discovering a persistent worker at all yields
 * an inconclusiveReason — it means the kernel arm was NOT running the
 * persistent bridge, and the cap verdict must not pretend it measured one.
 */
export function createWarmScheduleSampler(
  harnessPid: number,
  options?: { intervalMs?: number }
): WarmScheduleSampler {
  const intervalMs = options?.intervalMs ?? 250;
  let timer: NodeJS.Timeout | null = null;
  let sampler: RssSampler | null = null;
  let pids: GuardedPids | undefined;
  const combinedBytes: number[] = [];
  let inconclusiveReason: string | undefined;
  let samplingEnded = false;
  let ticking = false;
  let tickCount = 0;

  const tick = (): void => {
    if (ticking || samplingEnded) return;
    ticking = true;
    try {
      if (sampler === null) {
        const childPid = discoverChildPidByCommand(harnessPid, "kernel-child");
        if (childPid === null) return;
        const daemonPid = discoverChildPidByCommand(childPid, "strata-kernel-service");
        if (daemonPid === null) return;
        const workerPid = discoverPersistentWorkerPid(daemonPid);
        if (workerPid === null) return;
        pids = { daemon: daemonPid, worker: workerPid };
        sampler = createRssSampler(pids);
      }
      tickCount += 1;
      const point = sampler.sample(`warm-tick-${tickCount}`, "post-publish");
      combinedBytes.push(point.combined);
    } catch (error) {
      if (error instanceof PidContinuityViolation && pids !== undefined && !pidAlive(pids.daemon)) {
        // Whole-arm teardown (daemon gone too): the warm schedule is over;
        // this is not a respawn. Stop sampling without a violation.
        samplingEnded = true;
        return;
      }
      samplingEnded = true;
      inconclusiveReason = `big1k warm sampling: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      ticking = false;
    }
  };

  return {
    start(): void {
      if (timer === null) timer = setInterval(tick, intervalMs);
    },
    stop(): WarmScheduleSampling {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (sampler === null && inconclusiveReason === undefined) {
        inconclusiveReason =
          "big1k warm sampling: no persistent worker was ever discovered under the kernel arm during the warm schedule";
      }
      return {
        combinedBytes: [...combinedBytes],
        samples: sampler === null ? [] : [...sampler.samples()],
        ...(pids !== undefined ? { pids } : {}),
        continuityHeld: inconclusiveReason === undefined,
        ...(inconclusiveReason !== undefined ? { inconclusiveReason } : {})
      };
    }
  };
}
