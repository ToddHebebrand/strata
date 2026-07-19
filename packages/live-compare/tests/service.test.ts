// Directory-reuse lifecycle for the crash/parity harness (task 5 of the
// convergence slice): `stop({ preserveDirectory: true })` must leave
// `kernel.redb` on disk, and a second `startKernelService` pointed at that
// directory must reach readiness over the *recovery* branch (no re-ingest,
// no fresh seed) and keep serving the generation the first service produced.
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationClient } from "../src/client.js";
import { startKernelService } from "../src/service.js";
import { createQualifiedTaskManifest, type TaskAssignment } from "../src/tasks.js";
import { advanceUntilTerminal, beginAndSubmit, credentialFreeEnv, ensureBuilt } from "./serviceHarness.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

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
