import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactRun, readArtifactStream } from "../src/artifacts.js";
import { createSchedule } from "../src/schedule.js";
import { createQualifiedTaskManifest } from "../src/tasks.js";
import {
  REGISTERED_INTEGRATION_ROLE_BOUNDS,
  REGISTERED_TASK_ROLE_BOUNDS
} from "../src/baseline.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function runRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "strata-artifacts-"));
  temporary.push(path);
  return join(path, "run");
}

function fakeClock() {
  let wall = 1_700_000_000_000;
  let mono = 0;
  return {
    wallMs: () => (wall += 250),
    monoMs: () => (mono += 250)
  };
}

function experimentManifest() {
  const manifest = createQualifiedTaskManifest(corpusRoot);
  const schedule = createSchedule({ seed: "pilot-seed-1", trialsPerScenario: 1 });
  return {
    schemaVersion: 1 as const,
    corpusVariant: manifest.corpusVariant,
    sourceDigest: manifest.sourceDigest,
    graphDigest: manifest.graphDigest,
    taskRegistrationDigest: manifest.registrationDigest,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    taskRoleBounds: { ...REGISTERED_TASK_ROLE_BOUNDS },
    integrationRoleBounds: { ...REGISTERED_INTEGRATION_ROLE_BOUNDS },
    teamWallMs: 900_000,
    projectedMaxUsd: 55,
    seed: schedule.seed,
    schedule,
    typescriptRootNames: Object.keys(manifest.sourceFiles).sort(),
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
      allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, types: ["node"]
    },
    fixtureAllowlists: { D: ["phase6-invariant.mjs"] },
    fixtureDigests: manifest.packets.D.fixtureDigests,
    excludedInputs: manifest.excludedInputs,
    boundary: manifest.boundary,
    packageVersions: { "@strata/live-compare": "0.0.0" },
    machine: { platform: "darwin", arch: "arm64" },
    approval: { approvedBy: "operator", messageReference: "2026-07-16" }
  };
}

const sessionRecord = {
  schemaVersion: 1 as const,
  sessionId: "session:D:strata:agent-1",
  trialId: "D-r1",
  arm: "strata" as const,
  role: "task-1" as const,
  event: { type: "session_start", detail: "launch" }
};

describe("immutable run artifacts", () => {
  it("writes strict schema records with dual timestamps and finalizes immutably", () => {
    const root = runRoot();
    const run = createArtifactRun({ root, clock: fakeClock(), redactions: [] });
    run.write("experiment-manifest", experimentManifest());
    run.append("sessions", sessionRecord);
    run.append("service", {
      schemaVersion: 1, requestId: "request:1", clientId: "client:1",
      action: "submit_change_set", tick: "4", state: "ready"
    });
    run.append("kernel-events", {
      schemaVersion: 1, sequence: "1", changeSetId: "change:1", kind: "scope_expanded"
    });
    run.append("git-events", {
      schemaVersion: 1, trialId: "D-r1", kind: "capture", detail: "task-1"
    });
    run.write("verification", {
      schemaVersion: 1, packetId: "D", arm: "strata", green: true, generationZero: false,
      rootNames: ["src/cli.ts"],
      compilerOptions: { strict: true },
      fixtureNames: ["phase6-invariant.mjs"],
      fixtureDigests: { "phase6-invariant.mjs": "0".repeat(64) },
      excludedInputs: { "tests/format.test.ts": "0".repeat(64) },
      boundaryDispositions: [
        { path: "tests/format.test.ts", target: "logEvent", disposition: "frozen_excluded_historical" }
      ],
      sourceDigest: "0".repeat(64), finalTreeDigest: "0".repeat(64), configurationDigest: "0".repeat(64)
    }, { trialId: "D-r1", arm: "strata" });
    run.write("team", {
      schemaVersion: 1, trialId: "D-r1", arm: "strata", status: "success",
      makespanMs: 120000, totalAgentCostUsd: 0.61, failures: [], timeouts: []
    }, { trialId: "D-r1", arm: "strata" });

    const sessions = readArtifactStream(join(root, "sessions.jsonl"));
    expect(sessions.partialTail).toBe(false);
    expect(sessions.records).toHaveLength(1);
    const stamped = sessions.records[0] as Record<string, unknown>;
    expect(typeof stamped.wallTimeIso).toBe("string");
    expect(typeof stamped.monotonicMs).toBe("number");

    run.finalize({
      schemaVersion: 1, trialsRecorded: 1, sessionsRecorded: 1,
      totalCostUsd: 0.61, failures: 0, generatedFrom: "finalized trial records"
    });
    const marker = JSON.parse(readFileSync(join(root, "finalized.json"), "utf8"));
    expect(Object.keys(marker.contentHashes).length).toBeGreaterThanOrEqual(5);
    expect(() => run.append("sessions", sessionRecord)).toThrow(/finalized/);
    expect(() => createArtifactRun({ root, clock: fakeClock(), redactions: [] })).toThrow(/finalized/);
  });

  it("holds a full multi-trial pilot: per-trial team/verification, tasks, audit, and evidence", () => {
    const root = runRoot();
    const run = createArtifactRun({ root, clock: fakeClock(), redactions: [] });
    const team = (trialId: string, arm: "strata" | "baseline") => ({
      schemaVersion: 1 as const, trialId, arm, status: "success" as const,
      makespanMs: 100, totalAgentCostUsd: 0.5, failures: [], timeouts: []
    });
    run.write("team", team("D-r1", "strata"), { trialId: "D-r1", arm: "strata" });
    run.write("team", team("D-r1", "baseline"), { trialId: "D-r1", arm: "baseline" });
    run.write("team", team("M-r1", "strata"), { trialId: "M-r1", arm: "strata" });
    expect(() => run.write("team", team("D-r1", "strata"), { trialId: "D-r1", arm: "strata" }))
      .toThrow(/write-once/);

    run.write("tasks", {
      schemaVersion: 1, packetId: "D",
      assignments: [
        { role: "agent-1", taskBody: "body-1", promptHashes: { strata: "0".repeat(64), baseline: "0".repeat(64) } },
        { role: "agent-2", taskBody: "body-2", promptHashes: { strata: "0".repeat(64), baseline: "0".repeat(64) } }
      ]
    }, { packetId: "D" });

    run.write("canonical-audit", {
      schemaVersion: 1, trialId: "D-r1", arm: "strata", finalGeneration: "2",
      operations: [{ operationId: "operation:1", changeSetId: "change:1", actor: "phase6:agent-1" }]
    }, { trialId: "D-r1", arm: "strata" });

    run.writeEvidence({ trialId: "D-r1", arm: "strata" }, "final-tree/src/types/user.ts", "export interface Account {}\n");

    expect(existsSync(join(root, "trials/D-r1/strata/team.json"))).toBe(true);
    expect(existsSync(join(root, "trials/D-r1/baseline/team.json"))).toBe(true);
    expect(existsSync(join(root, "tasks/D.json"))).toBe(true);
    expect(existsSync(join(root, "trials/D-r1/strata/canonical-audit.json"))).toBe(true);
    expect(existsSync(join(root, "trials/D-r1/strata/evidence/final-tree/src/types/user.ts"))).toBe(true);

    run.finalize({
      schemaVersion: 1, trialsRecorded: 2, sessionsRecorded: 0,
      totalCostUsd: 1.5, failures: 0, generatedFrom: "finalized trial records"
    });
    const marker = JSON.parse(readFileSync(join(root, "finalized.json"), "utf8"));
    expect(Object.keys(marker.contentHashes)).toContain("trials/D-r1/strata/team.json");
    expect(Object.keys(marker.contentHashes)).toContain("trials/D-r1/strata/evidence/final-tree/src/types/user.ts");
    expect(() => run.writeEvidence({ trialId: "X-r1", arm: "strata" }, "late.txt", "no")).toThrow(/finalized/);
  });

  it("rejects malformed records for every stream", () => {
    const run = createArtifactRun({ root: runRoot(), clock: fakeClock(), redactions: [] });
    expect(() => run.write("experiment-manifest", { schemaVersion: 1 })).toThrow();
    expect(() => run.append("sessions", { ...sessionRecord, arm: "neither" })).toThrow();
    expect(() => run.append("service", { schemaVersion: 1 })).toThrow();
    expect(() => run.append("kernel-events", { schemaVersion: 1, sequence: 5 })).toThrow();
    expect(() => run.append("git-events", { schemaVersion: 1, unknown: true })).toThrow();
    expect(() => run.write("verification", { schemaVersion: 1, packetId: "D" }, { trialId: "D-r1", arm: "strata" })).toThrow();
    expect(() => run.write("team", { schemaVersion: 1, trialId: "D-r1" }, { trialId: "D-r1", arm: "strata" })).toThrow();
    expect(() => run.finalize({ schemaVersion: 1 })).toThrow();
  });

  it("redacts secrets and socket material from every stored value", () => {
    const root = runRoot();
    const run = createArtifactRun({
      root,
      clock: fakeClock(),
      redactions: ["/tmp/strata-lc/deadbeef.sock", "socket-token-1234"]
    });
    run.append("sessions", {
      ...sessionRecord,
      event: {
        type: "tool_result",
        detail: "connected /tmp/strata-lc/deadbeef.sock with socket-token-1234 and ANTHROPIC_API_KEY=sk-ant-xyz"
      }
    });
    const raw = readFileSync(join(root, "sessions.jsonl"), "utf8");
    expect(raw).not.toContain("deadbeef.sock");
    expect(raw).not.toContain("socket-token-1234");
    expect(raw).not.toContain("sk-ant-xyz");
    expect(raw).toContain("[redacted]");
  });

  it("reads crash-safe partial streams without losing complete records", () => {
    const root = runRoot();
    const run = createArtifactRun({ root, clock: fakeClock(), redactions: [] });
    run.append("git-events", { schemaVersion: 1, trialId: "D-r1", kind: "capture", detail: "task-1" });
    run.append("git-events", { schemaVersion: 1, trialId: "D-r1", kind: "capture", detail: "task-2" });
    appendFileSync(join(root, "git-events.jsonl"), '{"schemaVersion":1,"trialId":"D-r1","kind":"cap', "utf8");
    const stream = readArtifactStream(join(root, "git-events.jsonl"));
    expect(stream.records).toHaveLength(2);
    expect(stream.partialTail).toBe(true);
    expect(existsSync(join(root, "finalized.json"))).toBe(false);
  });
});
