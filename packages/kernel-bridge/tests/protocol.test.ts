import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bridgeRequestSchema,
  bridgeResponseSchema,
  type BridgeRequest,
  type BridgeResponse
} from "../src/index";

const FIXTURE_NAMES = [
  "analyze-request",
  "analyze-response",
  "analyze-response-add-parameter",
  "candidate-request",
  "candidate-response",
  "error-response"
] as const;

const fixturePath = (name: (typeof FIXTURE_NAMES)[number]) =>
  fileURLToPath(new URL(`fixtures/protocol-v1/${name}.json`, import.meta.url));

function fixture(name: (typeof FIXTURE_NAMES)[number]): unknown {
  return JSON.parse(readFileSync(fixturePath(name), "utf8"));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectRejected(value: unknown): void {
  expect(bridgeRequestSchema.safeParse(value).success).toBe(false);
}

function expectResponseRejected(value: unknown): void {
  expect(bridgeResponseSchema.safeParse(value).success).toBe(false);
}

describe("bridge protocol v1", () => {
  it("parses and byte-stably serializes shared golden messages", () => {
    for (const name of FIXTURE_NAMES) {
      const raw = readFileSync(fixturePath(name), "utf8");
      const value = JSON.parse(raw);
      const parsed = name.endsWith("request")
        ? bridgeRequestSchema.parse(value)
        : bridgeResponseSchema.parse(value);
      expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(raw);
    }
  });

  it("infers the public request and response unions", () => {
    const request: BridgeRequest = bridgeRequestSchema.parse(fixture("analyze-request"));
    const response: BridgeResponse = bridgeResponseSchema.parse(fixture("analyze-response"));
    expect(request.kind).toBe("analyzeIntent");
    expect(response.ok).toBe(true);
  });

  it("rejects unknown fields, versions, and kinds", () => {
    const base = fixture("analyze-request") as Record<string, unknown>;
    expectRejected({ ...base, extra: true });
    expectRejected({ ...base, protocolVersion: 2 });
    expectRejected({ ...base, kind: "deleteNode" });

    const nested = clone(base) as any;
    nested.binding.extra = true;
    expectRejected(nested);
  });

  it.each([0, 1, "01", "+1", "-1", "1.0", "1e3", " 1", "18446744073709551616"])(
    "rejects numeric or noncanonical u64 value %j",
    (generation) => {
      const request = clone(fixture("analyze-request")) as any;
      request.binding.graphGeneration = generation;
      request.snapshot.generation = generation;
      request.intent.baseGeneration = generation;
      expectRejected(request);
    }
  );

  it("accepts u64::MAX as a canonical wire value", () => {
    const request = clone(fixture("analyze-request")) as any;
    request.binding.serviceEpoch = "18446744073709551615";
    request.binding.graphGeneration = "18446744073709551615";
    request.snapshot.generation = "18446744073709551615";
    request.intent.baseGeneration = "18446744073709551615";
    expect(bridgeRequestSchema.safeParse(request).success).toBe(true);
  });

  it("rejects unsafe child indexes", () => {
    const request = clone(fixture("analyze-request")) as any;
    request.snapshot.nodes[1].childIndex = Number.MAX_SAFE_INTEGER + 1;
    expectRejected(request);
  });

  it("rejects duplicate IDs and duplicate reference sources", () => {
    const duplicateId = clone(fixture("analyze-request")) as any;
    duplicateId.snapshot.nodes.push({ ...duplicateId.snapshot.nodes[0] });
    expectRejected(duplicateId);

    const duplicateReference = clone(fixture("analyze-request")) as any;
    duplicateReference.snapshot.references = [
      { fromNodeId: "decl:greet", toNodeId: "module:main", kind: "value" },
      { fromNodeId: "decl:greet", toNodeId: "module:main", kind: "type" }
    ];
    expectRejected(duplicateReference);
  });

  it("rejects dangling parents and reference endpoints", () => {
    const danglingParent = clone(fixture("analyze-request")) as any;
    danglingParent.snapshot.nodes[1].parentId = "missing";
    expectRejected(danglingParent);

    const danglingReference = clone(fixture("analyze-request")) as any;
    danglingReference.snapshot.references = [
      { fromNodeId: "missing", toNodeId: "decl:greet", kind: "value" }
    ];
    expectRejected(danglingReference);
  });

  it("rejects snapshot and binding generation mismatches", () => {
    const request = clone(fixture("analyze-request")) as any;
    request.snapshot.generation = "1";
    expectRejected(request);
  });

  it("rejects invalid hashes and empty IDs", () => {
    const invalidHash = clone(fixture("analyze-request")) as any;
    invalidHash.binding.graphDigest = "ABC123";
    expectRejected(invalidHash);

    const invalidFingerprint = clone(fixture("candidate-request")) as any;
    invalidFingerprint.scopeFingerprint = "ABC123";
    expectRejected(invalidFingerprint);

    const emptyRequestId = clone(fixture("analyze-request")) as any;
    emptyRequestId.requestId = "";
    expectRejected(emptyRequestId);

    const emptyNodeId = clone(fixture("analyze-request")) as any;
    emptyNodeId.snapshot.nodes[0].id = "";
    expectRejected(emptyNodeId);
  });

  it("rejects unsupported intents and empty candidate intent lists", () => {
    const unsupported = clone(fixture("analyze-request")) as any;
    unsupported.intent.parameters = { type: "moveDeclaration", declarationId: "decl:greet" };
    expectRejected(unsupported);

    const empty = clone(fixture("candidate-request")) as any;
    empty.changeSet.orderedIntents = [];
    expectRejected(empty);
  });

  it("rejects duplicate intent IDs in candidate change sets", () => {
    const request = clone(fixture("candidate-request")) as any;
    request.changeSet.orderedIntents.push({
      ...request.changeSet.orderedIntents[0],
      parameters: {
        type: "renameSymbol",
        declarationId: "decl:greet",
        newName: "salute"
      }
    });
    expectRejected(request);
  });

  it("rejects candidate deltas bound to a different base generation", () => {
    const response = clone(fixture("candidate-response")) as any;
    response.result.delta.baseGeneration = "1";
    expectResponseRejected(response);
  });

  it("rejects malformed content dependency declarations", () => {
    const nonArray = clone(fixture("analyze-response-add-parameter")) as any;
    nonArray.result.facts.contentDependencyDeclarationIds = "decl:helper";
    expectResponseRejected(nonArray);

    const emptyEntry = clone(fixture("analyze-response-add-parameter")) as any;
    emptyEntry.result.facts.contentDependencyDeclarationIds = [""];
    expectResponseRejected(emptyEntry);
  });
});
