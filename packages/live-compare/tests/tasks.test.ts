import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildValidateCandidate } from "@strata/kernel-bridge";
import {
  APPROVED_CORPUS_VARIANT,
  assertApprovedTaskManifest,
  baselineTaskPrompt,
  createQualifiedKernelSnapshot,
  createQualifiedTaskManifest,
  strataTaskPrompt,
  type Phase6PacketId
} from "../src/tasks.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const preEnrichment = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/tasks/pre-enrichment-statement-ids.json"), "utf8")
) as { statements: Record<string, { id: string; childIndex: number; kind: string }[]> };
const temporary: string[] = [];

afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("Phase-6 task qualification", () => {
  it("freezes the approved x-namespace-enriched-v1 corpus from a fresh stable-root ingest", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    expect(APPROVED_CORPUS_VARIANT).toBe("x-namespace-enriched-v1");
    expect(manifest.corpusVariant).toBe("x-namespace-enriched-v1");
    expect(manifest.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.graphDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(manifest.targets).sort()).toEqual([
      "User", "displayUser", "eventLine", "formatTimestamp", "greet", "logEvent", "serialize"
    ]);
    for (const target of Object.values(manifest.targets)) {
      expect(target.stableId).toMatch(/^[0-9a-f]{16}$/);
      expect(target.baselineLocator.path).toMatch(/^src\//);
    }
    expect(manifest.targets.greet.incomingReferenceIds).toEqual([]);
    expect(manifest.greetNonCanonicalReferences).toEqual([]);
    expect(manifest.singleSitePackets).toEqual(["R", "S", "G"]);
    expect(() => assertApprovedTaskManifest(manifest)).not.toThrow();
  });

  it("requires the exact approved enrichment shape at generation zero", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const user = manifest.sourceFiles["src/types/user.ts"]!.text;
    expect(user).toContain("export function displayUser(user: User): string {");
    expect(user).toContain("return user.email;");
    expect(user.indexOf("export interface User")).toBeLessThan(user.indexOf("export function displayUser"));
    const serializer = manifest.sourceFiles["src/users/serializer.ts"]!.text;
    expect(serializer).toContain('import * as UserTypes from "../types/user.ts";');
    expect(serializer).not.toContain("import type * as UserTypes");
    expect(manifest.targets.displayUser.incomingReferenceIds).toEqual([]);
    expect(manifest.targets.displayUser.baselineLocator.path).toBe("src/types/user.ts");
    expect(manifest.targets.serialize.baselineLocator.path).toBe("src/users/serializer.ts");
  });

  it("preserves every pre-enrichment registered statement ID unchanged", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    for (const [modulePath, statements] of Object.entries(preEnrichment.statements)) {
      const registered = manifest.sourceFiles[modulePath];
      expect(registered, modulePath).toBeDefined();
      const ids = new Set(registered!.statementIds);
      for (const statement of statements) {
        expect(
          ids.has(statement.id),
          `${statement.kind} #${statement.childIndex} in ${modulePath} must keep its stable ID`
        ).toBe(true);
      }
    }
    const appended = manifest.sourceFiles["src/types/user.ts"]!.statementIds;
    expect(appended).toContain(manifest.targets.displayUser.stableId);
    const preExisting = new Set(preEnrichment.statements["src/types/user.ts"]!.map((statement) => statement.id));
    expect(preExisting.has(manifest.targets.displayUser.stableId)).toBe(false);
  });

  it("pins six packets, byte-identical bodies, appendices, hashes, and only approved intents", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    expect(Object.keys(manifest.packets)).toEqual(["D", "M", "R", "S", "X", "G"]);
    for (const [packetId, packet] of Object.entries(manifest.packets) as [Phase6PacketId, any][]) {
      expect(packet.id).toBe(packetId);
      expect(packet.assignments).toHaveLength(2);
      expect(packet.fixtureAllowlist).toEqual(["phase6-invariant.mjs"]);
      for (const assignment of packet.assignments) {
        expect(Buffer.from(assignment.taskBody, "utf8")).toEqual(
          Buffer.from(assignment.taskBodyBytes, "base64")
        );
        expect(assignment.promptHashes.strata).toMatch(/^[0-9a-f]{64}$/);
        expect(assignment.promptHashes.baseline).toMatch(/^[0-9a-f]{64}$/);
        expect(assignment.intents.every((intent: any) =>
          intent.type === "rename_symbol" || intent.type === "add_parameter"
        )).toBe(true);
      }
    }
    for (const packet of Object.values(manifest.packets)) {
      for (const assignment of packet.assignments) {
        const intentIds = assignment.intents.map((intent: any) =>
          intent.type === "rename_symbol" ? intent.declarationId : intent.functionId
        );
        const strataPrompt = strataTaskPrompt(assignment);
        const baselinePrompt = baselineTaskPrompt(assignment);
        for (const id of intentIds) {
          expect(strataPrompt, `${packet.id} ${assignment.role} strata prompt must supply ${id}`).toContain(id);
          expect(baselinePrompt.includes(id), `${packet.id} baseline prompt must not leak ${id}`).toBe(false);
        }
        for (const target of assignment.baselineTargets) {
          expect(baselinePrompt).toContain(target.path);
        }
        expect(createHash("sha256").update(strataPrompt).digest("hex")).toBe(assignment.promptHashes.strata);
        expect(createHash("sha256").update(baselinePrompt).digest("hex")).toBe(assignment.promptHashes.baseline);
      }
    }

    const x = manifest.packets.X;
    expect(x.assignments[0]!.intents).toEqual([
      { type: "rename_symbol", declarationId: manifest.targets.displayUser.stableId, newName: "formatUser" }
    ]);
    expect(x.assignments[1]!.intents).toEqual([
      {
        type: "add_parameter",
        functionId: manifest.targets.serialize.stableId,
        name: "displayLabel",
        typeText: "string",
        position: 1,
        value: "UserTypes.displayUser(user)"
      }
    ]);
  });

  it("fails closed on unresolved/structural intents and approval drift", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const structural = structuredClone(manifest) as any;
    structural.packets.D.assignments[0].intents[0].type = "move_declaration";
    expect(() => assertApprovedTaskManifest(structural)).toThrow(/operation class/);
    const unresolved = structuredClone(manifest) as any;
    unresolved.packets.D.assignments[0].intents[0].declarationId = "missing";
    expect(() => assertApprovedTaskManifest(unresolved)).toThrow(/unresolved/);
    const variant = structuredClone(manifest) as any;
    variant.corpusVariant = "current";
    expect(() => assertApprovedTaskManifest(variant)).toThrow(/approved corpus variant/);
    const digest = structuredClone(manifest) as any;
    digest.sourceDigest = "0".repeat(64);
    expect(() => assertApprovedTaskManifest(digest)).toThrow(/source digest/);
    for (const mutate of [
      (copy: any) => { copy.graphDigest = "0".repeat(64); },
      (copy: any) => { copy.targets.User.stableId = "0".repeat(16); },
      (copy: any) => { copy.packets.D.assignments[0].intents[0].newName = "Customer"; },
      (copy: any) => { copy.packets.X.assignments[1].intents[0].value = "UserTypes.formatUser(user)"; },
      (copy: any) => { copy.packets.D.assignments[0].promptHashes.strata = "0".repeat(64); },
      (copy: any) => { copy.packets.D.predicateDigest = "0".repeat(64); },
      (copy: any) => { copy.packets.D.fixtureDigests["phase6-invariant.mjs"] = "0".repeat(64); }
    ]) {
      const copy = structuredClone(manifest) as any;
      mutate(copy);
      expect(() => assertApprovedTaskManifest(copy)).toThrow(/registration digest|unresolved/);
    }
  });

  it("changes every registered digest when the source corpus changes", () => {
    const copy = mkdtempSync(join(tmpdir(), "strata-task-corpus-"));
    temporary.push(copy);
    cpSync(corpusRoot, copy, { recursive: true });
    const file = join(copy, "src/lib/dateRange.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`, "utf8");
    expect(() => createQualifiedTaskManifest(copy)).toThrow(/approved source digest/);
  });

  it("rejects a corpus missing either approved enrichment edit", () => {
    const withoutHelper = mkdtempSync(join(tmpdir(), "strata-task-plain-"));
    temporary.push(withoutHelper);
    cpSync(corpusRoot, withoutHelper, { recursive: true });
    const user = join(withoutHelper, "src/types/user.ts");
    writeFileSync(user, readFileSync(user, "utf8").replace(/export function displayUser[\s\S]*$/, ""), "utf8");
    expect(() => createQualifiedTaskManifest(withoutHelper)).toThrow(/displayUser|source digest/);

    const typeOnly = mkdtempSync(join(tmpdir(), "strata-task-typeonly-"));
    temporary.push(typeOnly);
    cpSync(corpusRoot, typeOnly, { recursive: true });
    const serializer = join(typeOnly, "src/users/serializer.ts");
    writeFileSync(
      serializer,
      readFileSync(serializer, "utf8").replace("import * as UserTypes", "import type * as UserTypes"),
      "utf8"
    );
    expect(() => createQualifiedTaskManifest(typeOnly)).toThrow(/value-capable|source digest/);
  });

  it("keeps every persisted statement ID derived from its unchanged physical Module path", () => {
    const snapshot = createQualifiedKernelSnapshot(corpusRoot);
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    for (const node of snapshot.nodes) {
      if (node.parentId === null || node.childIndex === null || byId.get(node.parentId)?.kind !== "Module") continue;
      const module = byId.get(node.parentId)!;
      const expected = createHash("sha1")
        .update(module.payload).update("\0").update(String(node.childIndex)).update("\0").update(node.kind)
        .digest("hex").slice(0, 16);
      expect(node.id, `${node.kind} under ${module.payload}`).toBe(expected);
    }
  });

  it("exports the exact complex X2 default from the same qualified physical-path snapshot", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const snapshot = { ...createQualifiedKernelSnapshot(corpusRoot), generation: "0" as any };
    const intent = manifest.packets.X.assignments[1]!.intents[0] as any;
    const changeSetId = "change:x2-complex-default";
    const result = buildValidateCandidate({
      protocolVersion: 1,
      requestId: "request:x2-complex-default",
      kind: "buildValidateCandidate",
      binding: { serviceEpoch: "1" as any, graphGeneration: "0" as any, graphDigest: manifest.graphDigest },
      snapshot: snapshot as any,
      attemptId: "attempt:x2-complex-default",
      scopeFingerprint: "0".repeat(64),
      changeSet: {
        changeSetId,
        actor: "phase6:x2",
        reasoning: "qualify complex default",
        orderedIntents: [{
          schemaVersion: 1,
          intentId: "intent:x2-complex-default",
          changeSetId,
          baseGeneration: "0" as any,
          parameters: {
            type: "addParameter",
            functionId: intent.functionId,
            name: intent.name,
            typeText: intent.typeText,
            position: intent.position,
            defaultValue: intent.value
          }
        }]
      },
      validationProfile: {
        mode: "tscOnly",
        sourceRoot: join(corpusRoot, "src"),
        corpusRoot,
        behavioralFixtures: [],
        strictSrcOnlyTscScope: true
      }
    });
    expect(result).toHaveProperty("delta");
  });
});
