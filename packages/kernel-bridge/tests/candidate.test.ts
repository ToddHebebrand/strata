import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelSnapshotV1
} from "@strata/ingest";
import { resolveCallsites } from "@strata/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDelta,
  buildValidateCandidate,
  exportSnapshot,
  hydrateSnapshot,
  type BridgeErrorPayload,
  type BuildValidateCandidateRequest
} from "../src/index";
import {
  buildValidateCandidateInScratch,
  validateCandidateIdentity
} from "../src/candidate";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(currentDir, "../../../examples/medium");
const sourceRoot = path.join(corpusRoot, "src");
const temporaryRoots: string[] = [];

function loadCorpus(root: string): { path: string; text: string }[] {
  const modules: { path: string; text: string }[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        modules.push({ path: absolutePath, text: readFileSync(absolutePath, "utf8") });
      }
    }
  }
  walk(root);
  return modules;
}

function mediumSnapshot(): KernelSnapshotV1 {
  return toKernelSnapshot(ingestBatch(loadCorpus(sourceRoot)), parseCanonicalU64("7"));
}

function declarationId(snapshot: KernelSnapshotV1, pattern: RegExp): string {
  const matches = snapshot.nodes.filter(
    (node) => node.parentId !== null && pattern.test(node.payload)
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.id;
}

function renameRequest(snapshot: KernelSnapshotV1): BuildValidateCandidateRequest {
  const changeSetId = "candidate-rename-change-set";
  return {
    protocolVersion: 1,
    requestId: "candidate-rename-request",
    kind: "buildValidateCandidate",
    binding: {
      serviceEpoch: parseCanonicalU64("1"),
      graphGeneration: snapshot.generation,
      graphDigest:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    snapshot,
    attemptId: "candidate-rename-attempt",
    scopeFingerprint:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    changeSet: {
      changeSetId,
      actor: "candidate-test-agent",
      reasoning: "prove a validated scratch rename",
      orderedIntents: [
        {
          schemaVersion: 1,
          intentId: "candidate-rename-intent",
          changeSetId,
          baseGeneration: snapshot.generation,
          parameters: {
            type: "renameSymbol",
            declarationId: declarationId(snapshot, /export interface User\s*\{/),
            newName: "Account"
          }
        }
      ]
    },
    validationProfile: {
      mode: "tscOnly",
      sourceRoot,
      corpusRoot,
      behavioralFixtures: [],
      strictSrcOnlyTscScope: true
    }
  };
}

function addParameterRequest(
  snapshot: KernelSnapshotV1,
  defaultValue: string | null = "false"
): BuildValidateCandidateRequest {
  const changeSetId = "candidate-parameter-change-set";
  return {
    ...renameRequest(snapshot),
    requestId: "candidate-parameter-request",
    attemptId: "candidate-parameter-attempt",
    changeSet: {
      changeSetId,
      actor: "candidate-test-agent",
      reasoning: "prove a validated uniform add-parameter mutation",
      orderedIntents: [
        {
          schemaVersion: 1,
          intentId: "candidate-parameter-intent",
          changeSetId,
          baseGeneration: snapshot.generation,
          parameters: {
            type: "addParameter",
            functionId: declarationId(snapshot, /export function greet\s*\(/),
            name: "excited",
            typeText: "boolean",
            position: 1,
            defaultValue
          }
        }
      ]
    }
  };
}

function expectSuccess(
  result: ReturnType<typeof buildValidateCandidate>
): Extract<typeof result, { delta: unknown }> {
  if (!("delta" in result)) {
    throw new Error(
      `expected candidate success, received ${result.stage}/${result.code}: ${result.message}`
    );
  }
  return result;
}

function expectFailure(
  result: ReturnType<typeof buildValidateCandidate>
): BridgeErrorPayload {
  if (!("stage" in result)) throw new Error("expected candidate failure");
  expect(result).not.toHaveProperty("delta");
  return result;
}

function assertIdentityBoundary(
  before: KernelSnapshotV1,
  after: KernelSnapshotV1,
  touchedStatementIds: ReadonlySet<string>
): void {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));
  expect(
    before.nodes.filter((node) => node.kind !== "Identifier").map((node) => node.id)
  ).toEqual(
    after.nodes.filter((node) => node.kind !== "Identifier").map((node) => node.id)
  );
  for (const node of before.nodes.filter(
    (item) => item.kind === "Identifier" && !touchedStatementIds.has(item.parentId ?? "")
  )) {
    expect(afterById.get(node.id)).toEqual(node);
  }
  for (const node of after.nodes.filter(
    (item) => item.kind === "Identifier" && !touchedStatementIds.has(item.parentId ?? "")
  )) {
    expect(beforeById.get(node.id)).toEqual(node);
  }
}

function behavioralMedium(): {
  corpusRoot: string;
  sourceRoot: string;
  snapshot: KernelSnapshotV1;
} {
  const root = mkdtempSync(path.join(tmpdir(), "strata-candidate-medium-"));
  temporaryRoots.push(root);
  cpSync(corpusRoot, root, { recursive: true });
  writeFileSync(
    path.join(root, "tests", "bridge-passing.test.ts"),
    'import { expect, it } from "vitest";\n' +
      'import { greet } from "../src/users/greet.ts";\n' +
      'it("keeps greet behavior", () => {\n' +
      '  expect(greet({ id: "1", email: "bridge@example.test" })).toBe("hello bridge@example.test");\n' +
      '});\n'
  );
  const src = path.join(root, "src");
  return {
    corpusRoot: root,
    sourceRoot: src,
    snapshot: toKernelSnapshot(
      ingestBatch(loadCorpus(src)),
      parseCanonicalU64("7")
    )
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("validated scratch candidates", () => {
  it("builds a TypeScript-clean real-corpus rename delta from one change set", () => {
    const before = mediumSnapshot();

    const result = expectSuccess(buildValidateCandidate(renameRequest(before)));

    expect(result.diagnostics).toEqual([]);
    const after = applyDelta(before, result.delta);
    const renamedIdentifiers = after.nodes.filter(
      (node) =>
        node.kind === "Identifier" &&
        (JSON.parse(node.payload) as { text?: string }).text === "Account"
    );
    expect(renamedIdentifiers.length).toBeGreaterThan(1);
    expect(
      after.nodes.some(
        (node) =>
          node.kind === "Identifier" &&
          (JSON.parse(node.payload) as { text?: string }).text === "User"
      )
    ).toBe(false);
    const target = renameRequest(before).changeSet.orderedIntents[0]!;
    if (target.parameters.type !== "renameSymbol") throw new Error("rename expected");
    const declarationName = before.nodes.find(
      (node) =>
        node.parentId === target.parameters.declarationId &&
        node.kind === "Identifier" &&
        (JSON.parse(node.payload) as { text?: string }).text === "User"
    )!;
    const touched = new Set<string>([target.parameters.declarationId]);
    for (const reference of before.references.filter(
      (item) => item.toNodeId === declarationName.id
    )) {
      touched.add(before.nodes.find((node) => node.id === reference.fromNodeId)!.parentId!);
    }
    assertIdentityBoundary(before, after, touched);
  });

  it("adds one uniform parameter value at every real greet callsite with bounded ID churn", () => {
    const before = mediumSnapshot();
    const request = addParameterRequest(before);
    const db = hydrateSnapshot(before);
    let callsites: ReturnType<typeof resolveCallsites>["callsites"];
    try {
      const intent = request.changeSet.orderedIntents[0]!;
      if (intent.parameters.type !== "addParameter") throw new Error("parameter expected");
      callsites = resolveCallsites(db, intent.parameters.functionId).callsites;
    } finally {
      db.close();
    }

    const result = expectSuccess(buildValidateCandidate(request));
    const after = applyDelta(before, result.delta);
    const intent = request.changeSet.orderedIntents[0]!;
    if (intent.parameters.type !== "addParameter") throw new Error("parameter expected");
    const functionNode = after.nodes.find((node) => node.id === intent.parameters.functionId)!;
    expect(functionNode.payload).toContain("excited: boolean = false");
    for (const callsite of callsites) {
      const statement = after.nodes.find((node) => node.id === callsite.statementId)!;
      expect(statement.payload).toMatch(/greet\([^)]*,\s*false\)/s);
      expect(statement.payload).not.toContain("true");
    }
    assertIdentityBoundary(
      before,
      after,
      new Set([intent.parameters.functionId, ...callsites.map((item) => item.statementId)])
    );
  });

  it("maps a null default value to the store operation's undefined input", () => {
    const before = mediumSnapshot();
    const request = addParameterRequest(before, null);
    const result = expectSuccess(buildValidateCandidate(request));
    const after = applyDelta(before, result.delta);
    const intent = request.changeSet.orderedIntents[0]!;
    if (intent.parameters.type !== "addParameter") throw new Error("parameter expected");
    expect(after.nodes.find((node) => node.id === intent.parameters.functionId)!.payload)
      .toContain("excited: boolean");
    expect(after.nodes.find((node) => node.id === intent.parameters.functionId)!.payload)
      .not.toContain("excited: boolean =");
  });

  it("applies ordered rename and add-parameter intents as one combined candidate", () => {
    const before = mediumSnapshot();
    const rename = renameRequest(before);
    const parameter = addParameterRequest(before);
    const request: BuildValidateCandidateRequest = {
      ...rename,
      requestId: "candidate-composite-request",
      attemptId: "candidate-composite-attempt",
      changeSet: {
        changeSetId: "candidate-composite-change-set",
        actor: "composite-agent",
        reasoning: "both operations are one atomic candidate",
        orderedIntents: [
          {
            ...rename.changeSet.orderedIntents[0]!,
            changeSetId: "candidate-composite-change-set"
          },
          {
            ...parameter.changeSet.orderedIntents[0]!,
            changeSetId: "candidate-composite-change-set"
          }
        ]
      }
    };

    const db = hydrateSnapshot(before);
    try {
      const result = expectSuccess(buildValidateCandidateInScratch(request, db));
      const transactions = db.prepare(
        "SELECT tx_id, status, actor FROM transactions ORDER BY started_at"
      ).all() as { tx_id: string; status: string; actor: string }[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({
        status: "committed",
        actor: "composite-agent"
      });
      const operations = db.prepare(
        "SELECT tx_id, kind, actor FROM operations ORDER BY ts, op_id"
      ).all() as { tx_id: string; kind: string; actor: string }[];
      expect(operations).toHaveLength(2);
      expect(new Set(operations.map((operation) => operation.tx_id))).toEqual(
        new Set([transactions[0]!.tx_id])
      );
      expect(operations.map((operation) => operation.kind).sort()).toEqual([
        "AddParameter",
        "RenameSymbol"
      ]);
      expect(operations.every((operation) => operation.actor === "composite-agent"))
        .toBe(true);

      const after = applyDelta(before, result.delta);
      expect(
        after.nodes.some(
          (node) => node.kind === "Identifier" &&
            (JSON.parse(node.payload) as { text?: string }).text === "Account"
        )
      ).toBe(true);
      const greetId = declarationId(before, /export function greet\s*\(/);
      expect(after.nodes.find((node) => node.id === greetId)!.payload)
        .toContain("excited: boolean = false");
    } finally {
      db.close();
    }
  });

  it("rolls back a valid first intent when the second intent fails", () => {
    const before = mediumSnapshot();
    const request = renameRequest(before);
    request.changeSet.orderedIntents.push({
      schemaVersion: 1,
      intentId: "invalid-second-intent",
      changeSetId: request.changeSet.changeSetId,
      baseGeneration: before.generation,
      parameters: {
        type: "addParameter",
        functionId: "missing-function",
        name: "excited",
        typeText: "boolean",
        position: 1,
        defaultValue: "false"
      }
    });
    const original = JSON.stringify(before);

    const db = hydrateSnapshot(before);
    try {
      const error = expectFailure(buildValidateCandidateInScratch(request, db));
      expect(error.stage).toBe("mutate");
      expect(JSON.stringify(exportSnapshot(db, before.generation))).toBe(original);
      expect(
        db.prepare("SELECT status FROM transactions").all()
      ).toEqual([{ status: "rolled_back" }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM operations").get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
    expect(JSON.stringify(before)).toBe(original);
    expectSuccess(buildValidateCandidate(renameRequest(before)));
  });

  it("rejects declaration/statement and out-of-scope identifier churn without a delta", () => {
    const before = mediumSnapshot();
    const statement = before.nodes.find(
      (node) => node.kind !== "Module" && node.kind !== "Identifier"
    )!;
    const withStatementChurn: KernelSnapshotV1 = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.id === statement.id ? { ...node, id: `${node.id}-churned` } : node
      )
    };
    const statementError = validateCandidateIdentity(
      before,
      withStatementChurn,
      new Set()
    );
    expect(statementError).toMatchObject({
      stage: "export",
      code: "unexpectedIdChurn"
    });
    expect(statementError).not.toHaveProperty("delta");

    const untouchedIdentifier = before.nodes.find(
      (node) => node.kind === "Identifier"
    )!;
    const withIdentifierChurn: KernelSnapshotV1 = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.id === untouchedIdentifier.id
          ? { ...node, payload: JSON.stringify({ text: "churned", offset: 0 }) }
          : node
      )
    };
    const identifierError = validateCandidateIdentity(
      before,
      withIdentifierChurn,
      new Set()
    );
    expect(identifierError).toMatchObject({
      stage: "export",
      code: "unexpectedIdChurn"
    });
    expect(identifierError).not.toHaveProperty("delta");
  });

  it("uses one explicitly scoped passing behavioral fixture and ignores unrelated red fixtures", () => {
    const fixture = behavioralMedium();
    const request = renameRequest(fixture.snapshot);
    request.validationProfile = {
      mode: "behavioral",
      sourceRoot: fixture.sourceRoot,
      corpusRoot: fixture.corpusRoot,
      behavioralFixtures: ["tests/bridge-passing.test.ts"],
      strictSrcOnlyTscScope: true
    };

    expectSuccess(buildValidateCandidate(request));
  });

  it.each([
    ["missing source root", { sourceRoot: path.join(corpusRoot, "missing") }],
    ["missing corpus root", { corpusRoot: path.join(corpusRoot, "missing") }],
    ["source root escaping corpus", { sourceRoot: path.dirname(corpusRoot) }]
  ])("rejects %s", (_label, override) => {
    const before = mediumSnapshot();
    const request = renameRequest(before);
    request.validationProfile = { ...request.validationProfile, ...override };
    const error = expectFailure(buildValidateCandidate(request));
    expect(error.stage).toBe("validate");
    expect(error.code).toBe("invalidValidationProfile");
  });

  it("rejects module paths outside the trusted source root", () => {
    const before = mediumSnapshot();
    const module = before.nodes.find((node) => node.kind === "Module")!;
    const escaped: KernelSnapshotV1 = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.id === module.id ? { ...node, payload: path.join(corpusRoot, "outside.ts") } : node
      )
    };
    const error = expectFailure(buildValidateCandidate(renameRequest(escaped)));
    expect(error.stage).toBe("validate");
    expect(error.code).toBe("moduleOutsideSourceRoot");
  });

  it.each([
    [[]],
    [["../package.json"]],
    [["package.json"]],
    [["tests/missing.test.ts"]]
  ])(
    "rejects empty or untrusted behavioral fixture selection %j",
    (behavioralFixtures) => {
      const fixture = behavioralMedium();
      const request = renameRequest(fixture.snapshot);
      request.validationProfile = {
        mode: "behavioral",
        sourceRoot: fixture.sourceRoot,
        corpusRoot: fixture.corpusRoot,
        behavioralFixtures,
        strictSrcOnlyTscScope: true
      };
      const error = expectFailure(buildValidateCandidate(request));
      expect(error.stage).toBe("validate");
      expect(error.code).toBe("invalidBehavioralFixtures");
    }
  );

  it("bounds normalized mutation failures and never returns a partial delta", () => {
    const before = mediumSnapshot();
    const request = renameRequest(before);
    const first = request.changeSet.orderedIntents[0]!;
    if (first.parameters.type !== "renameSymbol") throw new Error("rename expected");
    first.parameters.newName = `not-valid-${"x".repeat(100_000)}`;

    const error = expectFailure(buildValidateCandidate(request));

    expect(error.stage).toBe("mutate");
    expect(error.message.length).toBeLessThanOrEqual(1_000);
  });
});
