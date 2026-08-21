import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CoordinationClient } from "@strata-code/coordination-client";
import { materializeFinalTree, startKernelService } from "../src/service.js";
import { createQualifiedTaskManifest } from "../src/tasks.js";
import { advanceUntilTerminal, credentialFreeEnv, ensureBuilt } from "./serviceHarness.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
// Pinned LITERAL, deliberately not imported from tasks.ts: the in-file
// constant and computation can drift together in one commit; this line
// cannot (review Finding 5).
const FROZEN_REGISTRATION_DIGEST =
  "628bd6dabedc2e99b09375bb3b05da1663e6c25f86933113fd64497c1a140233";
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("zero-ID discovery bootstrap (spec B-1 gate b)", () => {
  it("resolves and publishes a T03-class rename from zero supplied IDs", async () => {
    ensureBuilt();
    const service = await startKernelService(corpusRoot, { env: credentialFreeEnv() });
    cleanups.push(() => service.stop());
    const client = new CoordinationClient({ socketPath: service.socketPath, clientId: "bootstrap:discovery:1" });

    // 1. Enumerate modules with a deliberately small page to exercise the
    //    cursor, and re-walk to pin determinism. NO IDs are known yet.
    //    Every page of a walk must report one generation (review Finding 6).
    const walkModules = async () => {
      const items: { moduleId: string; path: string; declarationCount: number }[] = [];
      const generations = new Set<string>();
      let after: string | undefined;
      for (;;) {
        const response = (await client.listModules(after ? { afterModuleId: after } : undefined, 2)) as any;
        expect(response.type).toBe("modules");
        generations.add(response.graphGeneration);
        items.push(...response.modules);
        if (!response.hasMore) break;
        after = response.modules.at(-1)!.moduleId;
      }
      expect(generations.size).toBe(1);
      return { items, generation: [...generations][0]! };
    };
    const first = await walkModules();
    const second = await walkModules();
    expect(second).toEqual(first);
    for (const module of first.items) {
      expect(module.path.startsWith("/")).toBe(false);
      expect(module.path).not.toMatch(/\\|(?:^|\/)\.\.(?:\/|$)/);
    }

    // 2. Locate the target by NAME via per-module declaration listing —
    //    the flow never calls global find_declarations.
    let discoveredId: string | undefined;
    let discoveredModuleId: string | undefined;
    for (const module of first.items) {
      let after: string | undefined;
      for (;;) {
        const response = (await client.listModuleDeclarations(module.moduleId, after ? { afterNodeId: after } : undefined, 64)) as any;
        expect(response.type).toBe("module_declarations");
        expect(response.graphGeneration).toBe(first.generation);
        for (const declaration of response.declarations) {
          if (declaration.name === "User" && declaration.kind === "InterfaceDeclaration") {
            expect(discoveredId).toBeUndefined();
            discoveredId = declaration.nodeId;
            discoveredModuleId = module.moduleId;
            expect(declaration.exported).toBe(true);
          }
        }
        if (!response.hasMore) break;
        after = response.declarations.at(-1)!.nodeId;
      }
    }
    expect(discoveredId).toBeDefined();

    // 3. Scoped find_declarations must agree with the listing route.
    //    (Task 5's client test proves this call serializes moduleId on the
    //    wire; Task 4's wrong-module control proves scoping is enforced.)
    const scoped = (await client.findDeclarations("User", { kind: "interface", moduleId: discoveredModuleId! })) as any;
    expect(scoped.declarations.map((entry: any) => entry.nodeId)).toEqual([discoveredId]);
    expect(scoped.hasMore).toBe(false);

    // 4. Page the incoming references (limit 1) and compare with one big
    //    page; one generation per walk.
    const walkReferences = async (limit: number) => {
      const items: any[] = [];
      const generations = new Set<string>();
      let after: string | undefined;
      for (;;) {
        const response = (await client.getReferences(discoveredId!, after ? { afterReferenceKey: after } : undefined, limit)) as any;
        expect(response.type).toBe("references");
        generations.add(response.graphGeneration);
        items.push(...response.references);
        if (!response.hasMore) break;
        after = response.references.at(-1)!.fromNodeId;
      }
      expect(generations.size).toBe(1);
      return items;
    };
    const paged = await walkReferences(1);
    expect(paged).toEqual(await walkReferences(256));
    expect(paged.length).toBeGreaterThan(0);
    const moduleIds = new Set(first.items.map((module) => module.moduleId));
    for (const reference of paged) expect(moduleIds.has(reference.moduleId)).toBe(true);

    // 5. Publish the discovered rename through the normal lifecycle.
    const begun = (await client.beginChangeSet("bootstrap: rename discovered User interface")) as any;
    await client.addIntent(begun.changeSetId, { type: "rename_symbol", declarationId: discoveredId!, newName: "Account" });
    await client.submitChangeSet(begun.changeSetId);
    const terminal = await advanceUntilTerminal(client, begun.changeSetId);
    expect(terminal.result.state).toBe("published");
    expect(terminal.result.publicationDigest).toMatch(/^[0-9a-f]{64}$/);

    // 6. ONLY NOW load the sealed manifest. Its constructor re-asserts its
    //    own digest; the pinned literal here additionally proves the
    //    registered corpus is the approved one even if tasks.ts drifted.
    const manifest = createQualifiedTaskManifest(corpusRoot);
    expect(manifest.registrationDigest).toBe(FROZEN_REGISTRATION_DIGEST);
    expect(discoveredId).toBe(manifest.targets.User.stableId);
    // Exact set equality: get_references' subtree semantics computes the
    // same population as the manifest's incomingReferenceIds.
    expect([...new Set(paged.map((reference: any) => reference.fromNodeId))].sort()).toEqual(
      manifest.targets.User.incomingReferenceIds
    );

    // 7. Materialize and spot-check the rename landed.
    const tree = await materializeFinalTree(client, corpusRoot, manifest, terminal.result.affectedNodeIds);
    cleanups.push(() => rmSync(tree, { recursive: true, force: true }));
    const userModule = readFileSync(join(tree, "src/types/user.ts"), "utf8");
    expect(userModule).toContain("interface Account");
    expect(userModule).not.toMatch(/\binterface User\b/);

    // 8. Corroboration (not proof — audit records carry no arguments): the
    //    flow's single find_declarations action is the scoped call above.
    const auditActions = readFileSync(service.auditPath, "utf8")
      .trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line).event.action).filter(Boolean);
    expect(auditActions.filter((action) => action === "find_declarations")).toHaveLength(1);
  }, 240_000);
});
