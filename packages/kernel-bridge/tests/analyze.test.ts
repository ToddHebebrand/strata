import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelSnapshotV1
} from "@strata/ingest";
import {
  findNodeById,
  getReferencesByTo,
  resolveCallsites,
  resolveDeclarationNameIdentifier
} from "@strata/store";
import { describe, expect, it } from "vitest";
import {
  analyzeIntent,
  analyzeIntentInDb,
  hydrateSnapshot,
  type AnalyzeIntentRequest,
  type BridgeErrorPayload
} from "../src/index";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function loadCorpus(root: string): { path: string; text: string }[] {
  const modules: { path: string; text: string }[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        modules.push({
          path: path.relative(root, absolutePath).replaceAll(path.sep, "/"),
          text: readFileSync(absolutePath, "utf8")
        });
      }
    }
  }
  walk(root);
  return modules;
}

function mediumSnapshot(): KernelSnapshotV1 {
  const root = path.resolve(currentDir, "../../../examples/medium/src");
  return toKernelSnapshot(
    ingestBatch(loadCorpus(root)),
    parseCanonicalU64("7")
  );
}

function declarationId(snapshot: KernelSnapshotV1, pattern: RegExp): string {
  const matches = snapshot.nodes.filter(
    (node) => node.parentId !== null && pattern.test(node.payload)
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.id;
}

function renameRequest(
  snapshot: KernelSnapshotV1,
  targetDeclarationId: string
): AnalyzeIntentRequest {
  return {
    protocolVersion: 1,
    requestId: "analyze-rename",
    kind: "analyzeIntent",
    binding: {
      serviceEpoch: parseCanonicalU64("1"),
      graphGeneration: snapshot.generation,
      graphDigest:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    snapshot,
    intent: {
      schemaVersion: 1,
      intentId: "intent-rename",
      changeSetId: "change-set-rename",
      baseGeneration: snapshot.generation,
      parameters: {
        type: "renameSymbol",
        declarationId: targetDeclarationId,
        newName: "Account"
      }
    }
  };
}

function addParameterRequest(
  snapshot: KernelSnapshotV1,
  functionId: string
): AnalyzeIntentRequest {
  return {
    ...renameRequest(snapshot, functionId),
    requestId: "analyze-parameter",
    intent: {
      schemaVersion: 1,
      intentId: "intent-parameter",
      changeSetId: "change-set-parameter",
      baseGeneration: snapshot.generation,
      parameters: {
        type: "addParameter",
        functionId,
        name: "excited",
        typeText: "boolean",
        position: 1,
        defaultValue: "false"
      }
    }
  };
}

function scratchSnapshot(modules: { path: string; text: string }[]): KernelSnapshotV1 {
  return toKernelSnapshot(ingestBatch(modules), parseCanonicalU64("3"));
}

function expectCanonicalUnique(values: readonly string[]): void {
  expect(values).toEqual([...new Set(values)].sort());
}

function expectError(
  result: { facts: unknown } | BridgeErrorPayload
): BridgeErrorPayload {
  if (!("stage" in result)) throw new Error("expected analysis error");
  return result;
}

describe("semantic intent analysis", () => {
  it("returns the complete canonical rename membership for the real User symbol", () => {
    const snapshot = mediumSnapshot();
    const userId = declarationId(snapshot, /export interface User\s*\{/);
    const db = hydrateSnapshot(snapshot);
    try {
      const name = resolveDeclarationNameIdentifier(db, userId);
      expect(name).toBeDefined();
      const references = getReferencesByTo(db, name!.id).sort((a, b) =>
        a.fromNodeId < b.fromNodeId ? -1 : a.fromNodeId > b.fromNodeId ? 1 : 0
      );

      const result = analyzeIntent(renameRequest(snapshot, userId));

      expect(result).toHaveProperty("facts");
      if (!("facts" in result) || result.facts.type !== "renameSymbol") {
        throw new Error("expected rename facts");
      }
      expect(result.facts.declarationId).toBe(userId);
      expect(result.facts.declarationNameIdentifierId).toBe(name!.id);
      expect(result.facts.references).toEqual(references);
      expect(result.facts.writableStatementIds).toEqual(
        [
          userId,
          ...references.map((reference) =>
            snapshot.nodes.find((node) => node.id === reference.fromNodeId)!
              .parentId!
          )
        ].filter((value, index, all) => all.indexOf(value) === index).sort()
      );
      expect(result.facts.validationDependencyNodeIds).toContain(userId);
      expect(result.facts.validationDependencyNodeIds).toContain(name!.id);
      for (const reference of references) {
        expect(result.facts.validationDependencyReferenceFromNodeIds).toContain(
          reference.fromNodeId
        );
      }
      expectCanonicalUnique(result.facts.writableStatementIds);
      expectCanonicalUnique(result.facts.validationDependencyNodeIds);
      expectCanonicalUnique(
        result.facts.validationDependencyReferenceFromNodeIds
      );
      const dependencyNodes = new Set(
        result.facts.validationDependencyNodeIds
      );
      const dependencyReferences = new Set(
        result.facts.validationDependencyReferenceFromNodeIds
      );
      for (const reference of snapshot.references) {
        if (dependencyNodes.has(reference.fromNodeId)) {
          expect(dependencyReferences).toContain(reference.fromNodeId);
          expect(dependencyNodes).toContain(reference.toNodeId);
        }
      }
      for (const module of snapshot.nodes.filter((node) => node.kind === "Module")) {
        const moduleIncluded = dependencyNodes.has(module.id);
        const directChildren = snapshot.nodes.filter(
          (node) => node.parentId === module.id
        );
        if (moduleIncluded) {
          expect(directChildren.every((node) => dependencyNodes.has(node.id))).toBe(
            true
          );
        }
      }
    } finally {
      db.close();
    }
  });

  it("keeps add-parameter call, arity-risk, body-read, and diagnostic facts separate", () => {
    const snapshot = mediumSnapshot();
    const greetId = declarationId(snapshot, /export function greet\s*\(/);
    const db = hydrateSnapshot(snapshot);
    try {
      const name = resolveDeclarationNameIdentifier(db, greetId);
      expect(name).toBeDefined();
      const resolution = resolveCallsites(db, greetId);
      const bodyReferences = snapshot.references
        .filter((reference) => {
          const source = findNodeById(db, reference.fromNodeId);
          return source?.parentId === greetId;
        })
        .sort((a, b) =>
          a.fromNodeId < b.fromNodeId ? -1 : a.fromNodeId > b.fromNodeId ? 1 : 0
        );

      const result = analyzeIntent(addParameterRequest(snapshot, greetId));

      expect(result).toHaveProperty("facts");
      if (!("facts" in result) || result.facts.type !== "addParameter") {
        throw new Error("expected add-parameter facts");
      }
      expect(result.facts.functionId).toBe(greetId);
      expect(result.facts.declarationNameIdentifierId).toBe(name!.id);
      expect(result.facts.directCallReferences.map((item) => item.fromNodeId)).toEqual(
        [...resolution.callsites.map((item) => item.referenceNodeId)].sort()
      );
      expect(result.facts.arityRiskStatementIds).toEqual(
        [...new Set(resolution.nonCallReferences.map((item) => item.statementId))].sort()
      );
      expect(result.facts.functionBodyReadReferences).toEqual(bodyReferences);
      expect(result.facts.unresolvedReferenceDiagnostics).toEqual([]);
      expect(result.facts.validationDependencyNodeIds).toContain(greetId);
      for (const reference of bodyReferences) {
        expect(result.facts.validationDependencyReferenceFromNodeIds).toContain(
          reference.fromNodeId
        );
      }
    } finally {
      db.close();
    }
  });

  it("widens add-parameter read and validation facts for a higher-order use", () => {
    const snapshot = scratchSnapshot([
      {
        path: "greet.ts",
        text: "export function greet(value: string): string { return value; }\n"
      },
      {
        path: "use.ts",
        text:
          'import { greet } from "./greet.ts";\nexport const mapped = ["a"].map(greet);\n'
      }
    ]);
    const greetId = declarationId(snapshot, /export function greet\s*\(/);

    const result = analyzeIntent(addParameterRequest(snapshot, greetId));

    expect(result).toHaveProperty("facts");
    if (!("facts" in result) || result.facts.type !== "addParameter") {
      throw new Error("expected add-parameter facts");
    }
    expect(result.facts.directCallReferences).toEqual([]);
    expect(result.facts.arityRiskReferences).toHaveLength(1);
    expect(result.facts.arityRiskStatementIds).toHaveLength(1);
    expect(result.facts.validationDependencyNodeIds).toEqual(
      expect.arrayContaining(result.facts.arityRiskStatementIds)
    );
    expect(result.facts.validationDependencyReferenceFromNodeIds).toContain(
      result.facts.arityRiskReferences[0]!.fromNodeId
    );
  });

  it("keeps direct-call and arity-risk references separate within one statement", () => {
    const snapshot = scratchSnapshot([
      {
        path: "greet.ts",
        text: "export function greet(value: string): string { return value; }\n"
      },
      {
        path: "use.ts",
        text:
          'import { greet } from "./greet.ts";\nexport const both = [greet, greet("a")];\n'
      }
    ]);
    const greetId = declarationId(snapshot, /export function greet\s*\(/);

    const result = analyzeIntent(addParameterRequest(snapshot, greetId));

    if (!("facts" in result) || result.facts.type !== "addParameter") {
      throw new Error("expected add-parameter facts");
    }
    expect(result.facts.directCallReferences).toHaveLength(1);
    expect(result.facts.arityRiskReferences).toHaveLength(1);
    expect(result.facts.directCallReferences[0]!.fromNodeId).not.toBe(
      result.facts.arityRiskReferences[0]!.fromNodeId
    );
  });

  it("fails closed with a bounded analyze/unresolvedReference error after hydration corruption", () => {
    const snapshot = scratchSnapshot([
      {
        path: "greet.ts",
        text: "export function greet(value: string): string { return value; }\n"
      },
      {
        path: "use.ts",
        text:
          'import { greet } from "./greet.ts";\nexport const message = greet("a");\n'
      }
    ]);
    const greetId = declarationId(snapshot, /export function greet\s*\(/);
    const db = hydrateSnapshot(snapshot);
    try {
      const name = resolveDeclarationNameIdentifier(db, greetId)!;
      const reference = getReferencesByTo(db, name.id).find((item) => {
        const source = findNodeById(db, item.fromNodeId);
        return source !== undefined && findNodeById(db, source.parentId!)?.kind !== "ImportDeclaration";
      });
      expect(reference).toBeDefined();
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM nodes WHERE id = ?").run(reference!.fromNodeId);

      const request = addParameterRequest(snapshot, greetId);
      const error = expectError(analyzeIntentInDb(db, request.intent));

      expect(error.stage).toBe("analyze");
      expect(error.code).toBe("unresolvedReference");
      expect(error.diagnostics).toHaveLength(1);
      expect(error.diagnostics[0]!.nodeId).toBe(reference!.fromNodeId);
      expect(error.diagnostics[0]!.message).not.toMatch(/[\r\n\t]/);
      expect(Object.hasOwn(error, "facts")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("keeps real User and formatTimestamp validation slices disjoint", () => {
    const snapshot = mediumSnapshot();
    const userId = declarationId(snapshot, /export interface User\s*\{/);
    const formatId = declarationId(
      snapshot,
      /export function formatTimestamp\s*\(/
    );
    const user = analyzeIntent(renameRequest(snapshot, userId));
    const format = analyzeIntent(renameRequest(snapshot, formatId));
    if (
      !("facts" in user) ||
      user.facts.type !== "renameSymbol" ||
      !("facts" in format) ||
      format.facts.type !== "renameSymbol"
    ) {
      throw new Error("expected rename facts");
    }

    const formatIds = new Set(format.facts.validationDependencyNodeIds);
    expect(
      user.facts.validationDependencyNodeIds.filter((id) => formatIds.has(id))
    ).toEqual([]);
    const formatReferences = new Set(
      format.facts.validationDependencyReferenceFromNodeIds
    );
    expect(
      user.facts.validationDependencyReferenceFromNodeIds.filter((id) =>
        formatReferences.has(id)
      )
    ).toEqual([]);
  });

  it("returns the stable identity of an internal validation member whose value changes", () => {
    const snapshot = mediumSnapshot();
    const userId = declarationId(snapshot, /export interface User\s*\{/);
    const initial = analyzeIntent(renameRequest(snapshot, userId));
    if (!("facts" in initial) || initial.facts.type !== "renameSymbol") {
      throw new Error("expected rename facts");
    }
    const internalId = initial.facts.validationDependencyNodeIds.find(
      (id) => id !== userId && snapshot.nodes.some((node) => node.id === id)
    );
    expect(internalId).toBeDefined();
    const changedSnapshot: KernelSnapshotV1 = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) =>
        node.id === internalId ? { ...node, payload: `${node.payload}\n` } : node
      )
    };
    const changed = analyzeIntent(renameRequest(changedSnapshot, userId));
    if (!("facts" in changed) || changed.facts.type !== "renameSymbol") {
      throw new Error("expected changed rename facts");
    }

    expect(changed.facts.validationDependencyNodeIds).toContain(internalId);
    expect(
      snapshot.nodes.find((node) => node.id === internalId)!.payload
    ).not.toBe(changedSnapshot.nodes.find((node) => node.id === internalId)!.payload);
  });
});
