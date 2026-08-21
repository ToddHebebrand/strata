// Behavioral rejection/parity gate — KERNEL path (item-B2 Task 8, spec B-2
// gate c). This is an ACCEPTANCE gate against Tasks 1-7's already-landed
// behavior, not failing-first TDD: a manifest-gated daemon, real vitest
// diagnostics on a semantic rejection, and a clean rename that still
// publishes through the same gate.
//
// Scenario: a temp copy of examples/medium plus one behavioral fixture
// (tests/behavioral/greet-contract.test.ts) that imports the real
// `src/users/greet.ts` and pins its behavior against a real `User` value.
// A behavioral manifest (mode "behavioral", strictSrcOnlyTscScope true,
// tsc/vitest timeouts 60_000/90_000) names that one fixture. The daemon's
// seed-green startup gate (Task 7) runs this exact fixture at generation
// zero before it will serve at all, so a red fixture would fail this file
// at `startKernelService(...)`, not at a later assertion — the seed-green
// enforcement IS part of this test, not a separate one.
//
//   - Rejected mutation: rename `greet` -> `welcomeUser`. Under
//     strictSrcOnlyTscScope the tsc pass covers src/** only, so the tree
//     still compiles; the fixture's runtime `import { greet }` then has no
//     such export, and vitest goes red. That is a SEMANTIC rejection
//     (state `validation_failed`, real diagnostics), never the retired
//     fabricated `candidate_validation_failed`.
//   - Clean mutation: rename `User` -> `Account`. The fixture only ever
//     names `User` in an `import type` — fully erased by the TS/esbuild
//     transform, so the fixture carries no runtime reference to it at all.
//     The rename still touches many other src modules (index.ts, audit.ts,
//     serializer.ts, legacy.ts, list.ts, repo.ts, user.ts itself) — that
//     bulk propagation is the project's known T03-class strength — and the
//     whole tree must still compile and the fixture must still pass.
//
// See packages/verify/tests/behavioralParity.test.ts for the PRODUCT gate
// (`commitWithBehavioralGate`, consumed as-is) exercising the identical two
// mutations over the identical fixture. THE STOP RULE: if the two gates
// disagree on either verdict, that is the gate doing its job — report both
// verdicts verbatim, do not normalize.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CoordinationClient } from "../src/client.js";
import { startKernelService, type RunningKernelService } from "../src/service.js";
import { advanceUntilTerminal, credentialFreeEnv, ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corpusSourceRoot = resolve(repoRoot, "examples/medium");

const FIXTURE_REL_PATH = "tests/behavioral/greet-contract.test.ts";
// Byte-identical to packages/verify/tests/behavioralParity.test.ts's fixture
// — the "same inputs" half of the parity oracle. Real `User` (from
// src/types/user.ts) requires only `id`/`email`; the v1 brief's
// `{ name: "Ada", email: "ada@example.com" } as unknown as User` skeleton
// both named a field `User` doesn't have AND used a lowercase email that
// would not satisfy `toContain("Ada")` against greet's real
// `` `hello ${user.email}` `` body. Corrected here: a real, fully-typed
// `User` value (no cast needed) with a capitalized email substring.
const FIXTURE_BODY =
  'import { describe, expect, it } from "vitest";\n' +
  'import { greet } from "../../src/users/greet.ts";\n' +
  'import type { User } from "../../src/types/user.ts";\n' +
  "\n" +
  'describe("greet behavioral contract", () => {\n' +
  '  it("greets by name", () => {\n' +
  '    const user: User = { id: "u1", email: "Ada@example.com" };\n' +
  '    expect(greet(user)).toContain("Ada");\n' +
  "  });\n" +
  "});\n";

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function buildBehavioralCorpus(): { corpusRoot: string; manifestPath: string } {
  const corpusRoot = mkdtempSync(join(tmpdir(), "strata-bgate-kernel-"));
  cleanups.push(() => rmSync(corpusRoot, { recursive: true, force: true }));
  // Mirror the established baselineMedium/private_medium_corpus pattern: a
  // stale node_modules/.vite cache in examples/medium would otherwise break
  // the spawned vitest run inside the copy.
  cpSync(corpusSourceRoot, corpusRoot, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules"
  });
  mkdirSync(join(corpusRoot, "tests", "behavioral"), { recursive: true });
  writeFileSync(join(corpusRoot, FIXTURE_REL_PATH), FIXTURE_BODY, "utf8");
  const sha256 = createHash("sha256")
    .update(readFileSync(join(corpusRoot, FIXTURE_REL_PATH)))
    .digest("hex");
  const manifestPath = join(corpusRoot, "validation-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "behavioral",
      strictSrcOnlyTscScope: true,
      tscTimeoutMs: 60_000,
      vitestTimeoutMs: 90_000,
      fixtures: [{ path: FIXTURE_REL_PATH, sha256 }]
    }),
    "utf8"
  );
  return { corpusRoot, manifestPath };
}

async function startGatedService(): Promise<{ service: RunningKernelService; client: CoordinationClient }> {
  ensureBuilt();
  const { corpusRoot, manifestPath } = buildBehavioralCorpus();
  // readinessTimeoutMsFor() auto-scales to GATED_READINESS_TIMEOUT_MS (240s)
  // because validationManifestPath is set (Task 7) — the seed-green baseline
  // spawns a real tsc + vitest before the daemon will bind its socket.
  const service = await startKernelService(corpusRoot, {
    env: credentialFreeEnv(),
    validationManifestPath: manifestPath
  });
  cleanups.push(() => service.stop());
  const client = new CoordinationClient({ socketPath: service.socketPath, clientId: "bgate:kernel" });
  return { service, client };
}

describe("behavioral rejection/parity gate — kernel path (spec B-2 gate c)", () => {
  it("rejects a compiles-but-behaviorally-wrong rename with real vitest diagnostics", async () => {
    const { service, client } = await startGatedService();

    const before = (await client.findDeclarations("greet", { kind: "function" })) as any;
    expect(before.type).toBe("declarations");
    expect(before.declarations.length).toBe(1);
    const declarationId: string = before.declarations[0].nodeId;
    const baselineGeneration: string = before.graphGeneration;

    const begun = (await client.beginChangeSet("behavioral gate: rename greet -> welcomeUser")) as any;
    await client.addIntent(begun.changeSetId, {
      type: "rename_symbol",
      declarationId,
      newName: "welcomeUser"
    });
    await client.submitChangeSet(begun.changeSetId);
    const terminal = await advanceUntilTerminal(client, begun.changeSetId);

    expect(terminal.result.state).toBe("validation_failed");
    const diagnostics = terminal.result.diagnostics as { code: string; message: string }[];
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(
      diagnostics.some((diagnostic) => diagnostic.code.startsWith("behavioralFailed")),
      `expected a behavioralFailed-prefixed diagnostic code: ${JSON.stringify(diagnostics)}`
    ).toBe(true);
    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes("greet")),
      `expected the real vitest failure text naming greet: ${JSON.stringify(diagnostics)}`
    ).toBe(true);

    // Generation unchanged: a rejection must never advance the graph.
    expect(terminal.result.graphGeneration).toBe(baselineGeneration);
    const after = (await client.findDeclarations("greet", { kind: "function" })) as any;
    expect(after.graphGeneration).toBe(baselineGeneration);
    expect(after.declarations[0].nodeId).toBe(declarationId);

    // The retired fabricated diagnostic must never appear — not in this
    // response, not anywhere in the audit trail.
    expect(JSON.stringify(terminal.result)).not.toContain("candidate_validation_failed");
    const auditText = readFileSync(service.auditPath, "utf8");
    expect(auditText).not.toContain("candidate_validation_failed");
  }, 240_000);

  it("publishes a clean rename the fixture cannot observe at runtime", async () => {
    const { client } = await startGatedService();

    const before = (await client.findDeclarations("User", { kind: "interface" })) as any;
    expect(before.declarations.length).toBe(1);
    const declarationId: string = before.declarations[0].nodeId;

    const begun = (await client.beginChangeSet("behavioral gate: rename User -> Account")) as any;
    await client.addIntent(begun.changeSetId, {
      type: "rename_symbol",
      declarationId,
      newName: "Account"
    });
    await client.submitChangeSet(begun.changeSetId);
    const terminal = await advanceUntilTerminal(client, begun.changeSetId);

    expect(terminal.result.state).toBe("published");
    expect(terminal.result.diagnostics).toEqual([]);
    expect(terminal.result.publicationDigest).toMatch(/^[0-9a-f]{64}$/);
  }, 240_000);
});
