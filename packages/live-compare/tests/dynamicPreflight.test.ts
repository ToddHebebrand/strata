import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQualifiedTaskManifest, scanCanonicalBoundary } from "../src/tasks.js";
import { runQualifiedServicePacket } from "./serviceHarness.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("canonical boundary and dynamic stop-gate preflight", () => {
  it("discovers the historical boundary inventory instead of assuming it", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    expect(manifest.boundary.filter((entry) => entry.path === "tests/format.test.ts").map((entry) => entry.target).sort()).toEqual(["formatTimestamp", "logEvent"]);
    expect(manifest.boundary.find((entry) => entry.path === "tests/dateRange.test.ts")).toMatchObject({ target: null, disposition: "frozen_excluded_historical" });
    expect(manifest.boundary.filter((entry) => entry.target === "displayUser" || entry.target === "serialize")).toEqual([]);
    expect(scanCanonicalBoundary(corpusRoot, manifest.targets)).toEqual(manifest.boundary);
  });

  it("fails closed on a changed historical fixture or new noncanonical target occurrence", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const copy = mkdtempSync(join(tmpdir(), "strata-boundary-"));
    temporary.push(copy);
    cpSync(corpusRoot, copy, { recursive: true });
    writeFileSync(join(copy, "tests/new.test.ts"), "// displayUser must be changed here\n", "utf8");
    expect(scanCanonicalBoundary(copy, manifest.targets)).not.toEqual(manifest.boundary);
    writeFileSync(join(copy, "tests/format.test.ts"), `${readFileSync(join(copy, "tests/format.test.ts"), "utf8")}\n`, "utf8");
    expect(() => createQualifiedTaskManifest(copy)).toThrow(/approved source digest|boundary|stable ID churned/);
  });

  it("qualifies D/R/S/G through two real service clients in both publication orders", async () => {
    for (const packetId of ["D", "R", "S", "G"] as const) {
      for (const order of ["agent-1-first", "agent-2-first"] as const) {
        const result = await runQualifiedServicePacket({ corpusRoot, packetId, order });
        expect(result.green, `${packetId} ${order}`).toBe(true);
        expect(result.generation, `${packetId} ${order}`).toBe(2);
        expect(result.operationIds).toHaveLength(2);
        expect(result.auditActions.filter((action) => action === "advance_change_set")).toHaveLength(2);
        expect(new Set(result.affectedNodeIds).size).toBe(result.affectedNodeIds.length);
        if (packetId === "D") expect(result.freshDecisions, `${packetId} ${order}`).toBe(0);
        if (packetId === "S") expect(result.stableDeclarationId).toBe(result.finalDeclarationId);
        if (packetId === "G") {
          expect(result.negativeControlGeneration).toBe(0);
          expect(result.aggregateAffectedNodeIds).toContain(result.stableDeclarationId);
        }
      }
    }
  }, 600_000);

  it("M same-module gate: serializes with exactly one fresh decision and converges", async () => {
    // Operator-amended acceptance (decisions.md 2026-07-16): the module-
    // granular validation dependency circle serializes same-module work. M
    // proves the successor queues at submit, records exactly one fresh
    // decision resubmitting the identical stable-ID typed intent, and both
    // orders converge to identical green digests. Within-module concurrent
    // publication is explicitly out of scope for this experiment.
    const results = [];
    for (const order of ["agent-1-first", "agent-2-first"] as const) {
      const result = await runQualifiedServicePacket({ corpusRoot, packetId: "M", order });
      expect(result.green, `M ${order}`).toBe(true);
      expect(result.generation, `M ${order}`).toBe(2);
      const expectedStates = order === "agent-1-first" ? ["ready", "queued"] : ["queued", "ready"];
      expect(result.submittedStates, `M ${order}`).toEqual(expectedStates);
      expect(result.freshDecisions, `M ${order}`).toBe(1);
      expect(result.finalSource).toContain("recordEvent");
      expect(result.finalSource).toContain("formatEventLine");
      expect(result.finalSource).not.toContain("logEvent");
      expect(result.finalSource).not.toContain("eventLine(");
      results.push(result);
    }
    expect(results[0]!.publicationDigest).toBe(results[1]!.publicationDigest);
    expect(results[0]!.finalTreeDigest).toBe(results[1]!.finalTreeDigest);
  }, 300_000);

  it("qualifies X in both orders with observable expansion and a stale-decision path", async () => {
    const x2First = await runQualifiedServicePacket({ corpusRoot, packetId: "X", order: "agent-2-first" });
    expect(x2First.green).toBe(true);
    expect(x2First.generation).toBe(2);
    expect(x2First.submittedStates).toEqual(["queued", "ready"]);
    expect(x2First.eventKinds).toContain("scope_expanded");
    expect(x2First.eventKinds).toContain("intent_ready");
    expect(x2First.scopeExpandedBeforePublishAdvance).toBe(true);
    expect(x2First.secondAdvances).toBe(1);
    expect(x2First.finalSource).toContain("displayLabel: string = UserTypes.formatUser(user)");
    expect(x2First.finalSource).not.toContain("displayUser");

    const x1First = await runQualifiedServicePacket({ corpusRoot, packetId: "X", order: "agent-1-first" });
    expect(x1First.green).toBe(true);
    expect(x1First.generation).toBe(2);
    expect(x1First.submittedStates).toEqual(["ready", "queued"]);
    expect(x1First.staleX2State).toBe("needs_decision");
    expect(x1First.finalSource).toContain("displayLabel: string = UserTypes.formatUser(user)");
    expect(x1First.finalSource).not.toContain("displayUser");

    expect(x1First.publicationDigest).toBe(x2First.publicationDigest);
    expect(x1First.finalTreeDigest).toBe(x2First.finalTreeDigest);
  }, 300_000);
});
