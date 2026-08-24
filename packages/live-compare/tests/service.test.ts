// Directory-reuse lifecycle for the crash/parity harness (task 5 of the
// convergence slice): `stop({ preserveDirectory: true })` must leave
// `kernel.redb` on disk, and a second `startKernelService` pointed at that
// directory must reach readiness over the *recovery* branch (no re-ingest,
// no fresh seed) and keep serving the generation the first service produced.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationClient } from "@strata-code/coordination-client";
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  GATED_READINESS_TIMEOUT_MS,
  readinessTimeoutMsFor,
  startKernelService
} from "../src/service.js";
import { createQualifiedTaskManifest, type TaskAssignment } from "../src/tasks.js";
import { advanceUntilTerminal, beginAndSubmit, credentialFreeEnv, ensureBuilt } from "./serviceHarness.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fakeServiceBinary(
  directory: string,
  readiness: Record<string, unknown>,
  stopExitCode = 0
): { binary: string; stopLog: string } {
  const binary = join(directory, "fake-strata-kernel-service");
  const pidPath = join(directory, "fake-service.pid");
  const stopLog = join(directory, "stop-argv.json");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
if (process.argv[2] === "serve") {
  writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  console.log(${JSON.stringify(JSON.stringify(readiness))});
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "stop") {
  appendFileSync(${JSON.stringify(stopLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  if (${stopExitCode} === 0) {
    process.kill(Number(readFileSync(${JSON.stringify(pidPath)}, "utf8")), "SIGTERM");
  }
  process.exit(${stopExitCode});
}
`,
    "utf8"
  );
  chmodSync(binary, 0o755);
  return { binary, stopLog };
}

const VALID_READINESS = {
  protocolVersion: 2,
  socketPath: "/tmp/fake-strata.sock",
  serviceEpoch: "7",
  recovered: false,
  validationMode: "tscOnly"
} as const;

describe("kernel service readiness identity and cleanup", () => {
  it("strictly retains readiness identity, normalizes the digest, and stops in band", async () => {
    const directory = mkdtempSync(join(tmpdir(), "strata-service-fake-"));
    temporary.push(directory);
    const fake = fakeServiceBinary(directory, VALID_READINESS);

    const service = await startKernelService(corpusRoot, {
      binaryPath: fake.binary,
      directory
    });
    expect(service).toMatchObject({
      socketPath: VALID_READINESS.socketPath,
      serviceEpoch: "7",
      recovered: false,
      validationMode: "tscOnly",
      validationManifestDigest: null
    });

    await service.stop({ preserveDirectory: true });
    const stopArgs = JSON.parse(readFileSync(fake.stopLog, "utf8").trim());
    expect(stopArgs).toEqual([
      "stop",
      "--socket",
      VALID_READINESS.socketPath,
      "--wait-ms",
      "30000"
    ]);
  });

  it.each([
    ["missing required key", { ...VALID_READINESS, serviceEpoch: undefined }],
    ["unknown key", { ...VALID_READINESS, redbPath: "/secret" }]
  ])("rejects readiness with a %s", async (_label, readiness) => {
    const directory = mkdtempSync(join(tmpdir(), "strata-service-invalid-ready-"));
    temporary.push(directory);
    const fake = fakeServiceBinary(directory, readiness);

    await expect(
      startKernelService(corpusRoot, { binaryPath: fake.binary, directory })
    ).rejects.toThrow();
  });

  it("falls back to SIGTERM when in-band stop cannot reach the socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "strata-service-stop-fallback-"));
    temporary.push(directory);
    const fake = fakeServiceBinary(directory, VALID_READINESS, 3);
    const service = await startKernelService(corpusRoot, {
      binaryPath: fake.binary,
      directory
    });

    await service.stop({ preserveDirectory: true });
    expect(service.child.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(fake.stopLog, "utf8").trim())).toEqual([
      "stop",
      "--socket",
      VALID_READINESS.socketPath,
      "--wait-ms",
      "30000"
    ]);
  });
});

describe("kernel service directory lifecycle", () => {
  it(
    "preserves kernel.redb across stop/restart and the recovery branch keeps serving the prior generation",
    async () => {
      ensureBuilt();
      const copy = mkdtempSync(join(tmpdir(), "strata-service-lifecycle-"));
      temporary.push(copy);
      cpSync(corpusRoot, copy, { recursive: true });

      const manifest = createQualifiedTaskManifest(copy);
      const rename: TaskAssignment = {
        role: "agent-1",
        taskBody: "",
        taskBodyBytes: "",
        intents: [{ type: "rename_symbol", declarationId: manifest.targets.greet.stableId, newName: "greetLifecycleRestart" }],
        strataTargets: [],
        baselineTargets: [],
        promptHashes: { strata: "", baseline: "" }
      };

      const first = await startKernelService(copy, { env: credentialFreeEnv() });
      let directory: string;
      let declarationId: string;
      try {
        directory = first.directory;
        declarationId = manifest.targets.greet.stableId;
        const client = new CoordinationClient({ socketPath: first.socketPath, clientId: "service-lifecycle:1" });
        const begun = await beginAndSubmit(client, rename, "lifecycle rename before restart");
        const terminal = await advanceUntilTerminal(client, begun.changeSetId);
        expect(terminal.result.state).toBe("published");
      } finally {
        await first.stop({ preserveDirectory: true });
      }

      expect(existsSync(join(directory!, "kernel.redb"))).toBe(true);

      const second = await startKernelService(copy, { directory: directory!, env: credentialFreeEnv() });
      try {
        expect(second.directory).toBe(directory!);
        const client2 = new CoordinationClient({ socketPath: second.socketPath, clientId: "service-lifecycle:2" });
        const inspected = (await client2.request({ type: "inspect_nodes", nodeIds: [declarationId!] }, 120_000)) as any;
        const payload = inspected.nodes.find((node: any) => node.nodeId === declarationId)?.payload;
        expect(payload).toContain("greetLifecycleRestart");
      } finally {
        await second.stop();
      }

      expect(existsSync(directory!)).toBe(false);
    },
    240_000
  );
});

/**
 * B-2 Task 7: a manifest-gated daemon runs a full tsc (plus fixtures) against
 * generation zero BEFORE its readiness line, which the historic hard-coded 10s
 * budget cannot meet. The budget scales off the manifest; the no-manifest
 * default is untouched.
 */
describe("kernel service readiness budget", () => {
  it("keeps 10s without a manifest and scales for a gated daemon", () => {
    expect(readinessTimeoutMsFor()).toBe(DEFAULT_READINESS_TIMEOUT_MS);
    expect(readinessTimeoutMsFor({})).toBe(DEFAULT_READINESS_TIMEOUT_MS);
    expect(readinessTimeoutMsFor({ env: credentialFreeEnv() })).toBe(
      DEFAULT_READINESS_TIMEOUT_MS
    );

    expect(readinessTimeoutMsFor({ validationManifestPath: "/tmp/m.json" })).toBe(
      GATED_READINESS_TIMEOUT_MS
    );
    // A manifest smuggled in through extraArgs scales the budget too.
    expect(
      readinessTimeoutMsFor({ extraArgs: ["--validation-manifest", "/tmp/m.json"] })
    ).toBe(GATED_READINESS_TIMEOUT_MS);

    // An explicit override always wins, in both directions.
    expect(
      readinessTimeoutMsFor({ validationManifestPath: "/tmp/m.json", readinessTimeoutMs: 25 })
    ).toBe(25);
    expect(readinessTimeoutMsFor({ readinessTimeoutMs: 999_000 })).toBe(999_000);
  });

  it("plumbs validationManifestPath through to the daemon's argv", async () => {
    ensureBuilt();
    const directory = mkdtempSync(join(tmpdir(), "strata-service-manifest-"));
    temporary.push(directory);
    const missingManifest = join(directory, "no-such-manifest.json");

    // The daemon must FAIL naming this exact path — which it can only do if the
    // flag reached its argv. The failure is immediate, so the (240s) gated
    // budget is never actually waited on here; Task 8's gate exercises the
    // long-readiness path end to end.
    await expect(
      startKernelService(corpusRoot, {
        env: credentialFreeEnv(),
        directory,
        validationManifestPath: missingManifest
      })
    ).rejects.toThrow(/load validation manifest .*no-such-manifest\.json/s);
  }, 60_000);
});
