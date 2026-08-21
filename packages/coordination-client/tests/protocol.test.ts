import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_ACTION_TYPES,
  isMutatingAction,
  laneForAction,
  LocalServiceProtocolContext,
  MAX_OPERATION_INTENTS,
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  parseRequestFrame,
  parseResponseFrame,
  requestActionSchema,
  responseResultSchema,
  serializeRequestFrame,
  serializeResponseFrame
} from "../src/index";

type Direction = "request" | "response";
type FixtureCase = { name: string; direction: Direction; value: unknown };
const RAW_REJECTED_FIXTURES = [
  "duplicate-key",
  "position-exponent",
  "position-negative-zero",
  "lone-surrogate"
] as const;

function fixture<T>(name: "accepted" | "rejected"): T {
  const path = fileURLToPath(new URL(`fixtures/protocol-v2/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function frame(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function rawRejectedFrame(name: (typeof RAW_REJECTED_FIXTURES)[number]): Uint8Array {
  const path = fileURLToPath(
    new URL(`fixtures/protocol-v2/raw-rejected/${name}.json`, import.meta.url)
  );
  return readFileSync(path);
}

function rawAcceptedFrame(name: "reordered-whitespace" | "surrogate-pair"): Uint8Array {
  const path = fileURLToPath(
    new URL(`fixtures/protocol-v2/raw-accepted/${name}.json`, import.meta.url)
  );
  return readFileSync(path);
}

function changedInspectRequest(): Record<string, unknown> {
  const accepted = fixture<{ cases: FixtureCase[] }>("accepted");
  const value = structuredClone(
    accepted.cases.find((entry) => entry.name === "inspect-nodes-request")!.value
  ) as any;
  value.action.nodeIds = ["node:other"];
  return value;
}

describe("local service protocol v1", () => {
  it("accepts every shared golden message and serializes one LF frame", () => {
    const accepted = fixture<{ cases: FixtureCase[] }>("accepted");
    for (const testCase of accepted.cases) {
      const parsed =
        testCase.direction === "request"
          ? parseRequestFrame(frame(testCase.value))
          : parseResponseFrame(frame(testCase.value));
      const encoded =
        testCase.direction === "request"
          ? serializeRequestFrame(parsed as Parameters<typeof serializeRequestFrame>[0])
          : serializeResponseFrame(parsed as Parameters<typeof serializeResponseFrame>[0]);
      expect(new TextDecoder().decode(encoded)).toBe(`${JSON.stringify(testCase.value)}\n`);
      expect([...encoded].filter((byte) => byte === 0x0a)).toHaveLength(1);
    }
  });

  it("exposes the bounded public coordination event kind without authority data", () => {
    const accepted = fixture<{ cases: FixtureCase[] }>("accepted");
    const value = accepted.cases.find((entry) => entry.name === "read-events-response")!.value;
    const parsed = parseResponseFrame(frame(value));
    expect(parsed.ok && parsed.result.type === "events" && parsed.result.events[0]?.kind).toBe(
      "intent_committed"
    );
  });

  it("rejects every shared invalid request or response", () => {
    const rejected = fixture<{ cases: FixtureCase[] }>("rejected");
    for (const testCase of rejected.cases) {
      const parse = testCase.direction === "request" ? parseRequestFrame : parseResponseFrame;
      expect(() => parse(frame(testCase.value)), testCase.name).toThrow();
    }
  });

  it.each(RAW_REJECTED_FIXTURES)(
    "rejects shared byte-preserving raw JSON representation %s",
    (name) => {
      expect(() => parseRequestFrame(rawRejectedFrame(name))).toThrow();
    }
  );

  it("accepts shared raw JSON with reordered properties and insignificant whitespace", () => {
    expect(() => parseRequestFrame(rawAcceptedFrame("reordered-whitespace"))).not.toThrow();
  });

  it("accepts a shared raw JSON paired UTF-16 surrogate escape", () => {
    expect(() => parseRequestFrame(rawAcceptedFrame("surrogate-pair"))).not.toThrow();
  });

  it("rejects missing, empty, extra, and multiple frames", () => {
    expect(() => parseRequestFrame(new TextEncoder().encode("{}"))).toThrow();
    expect(() => parseRequestFrame(new TextEncoder().encode("\n"))).toThrow();
    expect(() => parseRequestFrame(new TextEncoder().encode("{}\n "))).toThrow();
    expect(() => parseRequestFrame(new TextEncoder().encode("{}\n{}\n"))).toThrow();
  });

  it("rejects invalid UTF-8 and JSON fatally", () => {
    expect(() => parseRequestFrame(Uint8Array.from([0xff, 0x0a]))).toThrow();
    expect(() => parseRequestFrame(new TextEncoder().encode("{]\n"))).toThrow();
  });

  it("rejects frames over the request and response bounds before schema parsing", () => {
    expect(() => parseRequestFrame(new Uint8Array(MAX_REQUEST_FRAME_BYTES + 1))).toThrow(
      /frame exceeds/
    );
    expect(() => parseResponseFrame(new Uint8Array(MAX_RESPONSE_FRAME_BYTES + 1))).toThrow(
      /frame exceeds/
    );
  });

  it("rejects duplicate request IDs when their canonical bodies differ", () => {
    const accepted = fixture<{ cases: FixtureCase[] }>("accepted");
    const original = accepted.cases.find((entry) => entry.name === "inspect-nodes-request")!.value;
    const context = new LocalServiceProtocolContext();
    parseRequestFrame(frame(original), context);
    expect(() => parseRequestFrame(frame(changedInspectRequest()), context)).toThrow(
      /request ID was already used with a different body/
    );
    expect(() => parseRequestFrame(frame(original), context)).not.toThrow();
  });

  it("rejects cross-client access to an actor-bound change set", () => {
    const accepted = fixture<{ cases: FixtureCase[] }>("accepted");
    const submit = structuredClone(
      accepted.cases.find((entry) => entry.name === "submit-change-set-request")!.value
    ) as any;
    submit.clientId = "client:beta";
    const context = new LocalServiceProtocolContext();
    context.recordChangeSetOwner("change:1", "client:alpha");
    expect(() => parseRequestFrame(frame(submit), context)).toThrow(
      /change set belongs to a different client/
    );
  });

  it("bounds duplicate and ownership validation context", () => {
    const context = new LocalServiceProtocolContext(1, 1);
    context.recordChangeSetOwner("change:1", "client:alpha");
    expect(() => context.recordChangeSetOwner("change:2", "client:alpha")).toThrow(
      /context capacity/
    );

    const accepted = fixture<{ cases: FixtureCase[] }>("accepted");
    const first = accepted.cases.find((entry) => entry.name === "hello-request")!.value;
    const second = accepted.cases.find((entry) => entry.name === "inspect-nodes-request")!.value;
    parseRequestFrame(frame(first), context);
    expect(() => parseRequestFrame(frame(second), context)).toThrow(/context capacity/);
  });

  it("round-trips find_declarations request and declarations result", () => {
    const action = requestActionSchema.parse({
      type: "find_declarations",
      name: "User",
      kind: "interface"
    });
    expect(action).toEqual({ type: "find_declarations", name: "User", kind: "interface" });
    const result = responseResultSchema.parse({
      type: "declarations",
      graphGeneration: "3",
      declarations: [{ nodeId: "a", kind: "interface", name: "User", moduleId: "m" }],
      hasMore: false
    });
    expect(result.type).toBe("declarations");
  });

  it("round-trips a scoped find_declarations request with moduleId and afterNodeId", () => {
    const action = requestActionSchema.parse({
      type: "find_declarations",
      name: "User",
      moduleId: "module:user",
      afterNodeId: "node:user"
    });
    expect(action).toEqual({
      type: "find_declarations",
      name: "User",
      moduleId: "module:user",
      afterNodeId: "node:user"
    });
  });

  it("round-trips list_modules request and modules result", () => {
    const action = requestActionSchema.parse({
      type: "list_modules",
      afterModuleId: "module:a",
      limit: 32
    });
    expect(action).toEqual({ type: "list_modules", afterModuleId: "module:a", limit: 32 });
    const result = responseResultSchema.parse({
      type: "modules",
      graphGeneration: "5",
      modules: [{ moduleId: "module:a", path: "src/a.ts", declarationCount: 3 }],
      hasMore: true
    });
    expect(result.type).toBe("modules");
  });

  it("round-trips list_module_declarations request and module_declarations result", () => {
    const action = requestActionSchema.parse({
      type: "list_module_declarations",
      moduleId: "module:a",
      limit: 32
    });
    expect(action).toEqual({ type: "list_module_declarations", moduleId: "module:a", limit: 32 });
    const result = responseResultSchema.parse({
      type: "module_declarations",
      graphGeneration: "5",
      declarations: [
        { nodeId: "node:user", name: "User", kind: "InterfaceDeclaration", exported: true },
        { nodeId: "node:local", name: null, kind: "FirstStatement", exported: false }
      ],
      hasMore: false
    });
    expect(result.type).toBe("module_declarations");
  });

  it("round-trips get_references request and references result", () => {
    const action = requestActionSchema.parse({
      type: "get_references",
      nodeId: "node:user",
      limit: 64
    });
    expect(action).toEqual({ type: "get_references", nodeId: "node:user", limit: 64 });
    const result = responseResultSchema.parse({
      type: "references",
      graphGeneration: "5",
      references: [{ fromNodeId: "node:format-user", kind: "call", moduleId: "module:a" }],
      hasMore: false
    });
    expect(result.type).toBe("references");
  });

  it("accepts a diagnostic modulePath as optional, absent, and rejects an absolute path", () => {
    const withPath = responseResultSchema.parse({
      type: "change_set",
      changeSetId: "change:1",
      state: "needs_decision",
      ticketState: "needs_decision",
      graphGeneration: "8",
      operationId: null,
      affectedNodeIds: [],
      diagnostics: [
        { code: "c", message: "m", nodeId: "node:user", modulePath: "src/types/user.ts" },
        { code: "c2", message: "m2", nodeId: null }
      ],
      publicationDigest: null,
      renamedSymbols: []
    });
    if (withPath.type !== "change_set") throw new Error("expected change_set");
    expect(withPath.diagnostics[0]).toEqual({
      code: "c",
      message: "m",
      nodeId: "node:user",
      modulePath: "src/types/user.ts"
    });
    expect(withPath.diagnostics[1]).toEqual({ code: "c2", message: "m2", nodeId: null });
    expect(() =>
      responseResultSchema.parse({
        type: "change_set",
        changeSetId: "change:1",
        state: "needs_decision",
        ticketState: "needs_decision",
        graphGeneration: "8",
        operationId: null,
        affectedNodeIds: [],
        diagnostics: [{ code: "c", message: "m", nodeId: null, modulePath: "/etc/passwd" }],
        publicationDigest: null,
        renamedSymbols: []
      })
    ).toThrow();
  });

  it("round-trips read_operation request and operation result", () => {
    const action = requestActionSchema.parse({
      type: "read_operation",
      operationId: "operation:1"
    });
    expect(action).toEqual({ type: "read_operation", operationId: "operation:1" });
    const result = responseResultSchema.parse({
      type: "operation",
      graphGeneration: "4",
      operationId: "operation:1",
      changeSetId: "change:1",
      actor: "client:alpha",
      kind: "RenameSymbol",
      reasoning: "rename User to Account",
      affectedNodeIds: ["a", "b"],
      renames: [{ nodeId: "a", fromName: "User", toName: "Account" }],
      intents: [
        {
          kind: "RenameSymbol",
          parametersJson: '{"type":"renameSymbol","declarationId":"a","newName":"Account"}'
        }
      ],
      publicationDigest: "a".repeat(64)
    });
    expect(result.type).toBe("operation");
  });

  it("rejects a read_operation result whose publicationDigest is not 64 lowercase hex characters", () => {
    expect(() =>
      responseResultSchema.parse({
        type: "operation",
        graphGeneration: "4",
        operationId: "operation:1",
        changeSetId: "change:1",
        actor: "client:alpha",
        kind: "RenameSymbol",
        reasoning: "rename User to Account",
        affectedNodeIds: [],
        renames: [],
        intents: [],
        publicationDigest: "not-a-digest"
      })
    ).toThrow();
  });

  it("bounds read_validation_fixture length to 1..=8192 with a 64-hex fixture ID", () => {
    const fixtureId = "c".repeat(64);
    expect(
      requestActionSchema.parse({
        type: "read_validation_fixture",
        fixtureId,
        offset: "0",
        length: 8192
      })
    ).toEqual({ type: "read_validation_fixture", fixtureId, offset: "0", length: 8192 });
    expect(requestActionSchema.parse({ type: "list_validation_fixtures" })).toEqual({
      type: "list_validation_fixtures"
    });
    for (const invalid of [
      { type: "read_validation_fixture", fixtureId, offset: "0", length: 0 },
      { type: "read_validation_fixture", fixtureId, offset: "0", length: 8193 },
      { type: "read_validation_fixture", fixtureId, offset: "00", length: 64 },
      { type: "read_validation_fixture", fixtureId: "C".repeat(64), offset: "0", length: 64 },
      { type: "list_validation_fixtures", fixtureId }
    ]) {
      expect(requestActionSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(
        false
      );
    }
  });

  it("rejects a read_validation_fixture request carrying an idempotency key", () => {
    const request = {
      protocolVersion: 2,
      requestId: "request:fixtures",
      clientId: "client:alpha",
      deadlineMs: "30000",
      action: {
        type: "read_validation_fixture",
        fixtureId: "c".repeat(64),
        offset: "0",
        length: 64
      }
    };
    expect(() => parseRequestFrame(frame(request))).not.toThrow();
    expect(() =>
      parseRequestFrame(frame({ ...request, idempotencyKey: "key:1" }))
    ).toThrow(/read-only actions must not carry an idempotency key/);
  });

  it("bounds the validation_fixtures result to 64 registered fixtures with a nullable manifest digest", () => {
    const fixtureId = "c".repeat(64);
    const summary = { fixtureId, path: "tests/greet.test.ts", bytes: "120" };
    expect(
      responseResultSchema.parse({
        type: "validation_fixtures",
        validationMode: "behavioral",
        validationManifestDigest: "b".repeat(64),
        fixtures: [summary]
      })
    ).toEqual({
      type: "validation_fixtures",
      validationMode: "behavioral",
      validationManifestDigest: "b".repeat(64),
      fixtures: [summary]
    });
    expect(
      responseResultSchema.safeParse({
        type: "validation_fixtures",
        validationMode: "tscOnly",
        validationManifestDigest: null,
        fixtures: []
      }).success
    ).toBe(true);
    // Required-but-nullable, exactly like `ready`: an omitted key is not `null`.
    expect(
      responseResultSchema.safeParse({
        type: "validation_fixtures",
        validationMode: "tscOnly",
        fixtures: []
      }).success
    ).toBe(false);
    expect(
      responseResultSchema.safeParse({
        type: "validation_fixtures",
        validationMode: "behavioral",
        validationManifestDigest: null,
        fixtures: Array.from({ length: 64 }, () => summary)
      }).success
    ).toBe(true);
    expect(
      responseResultSchema.safeParse({
        type: "validation_fixtures",
        validationMode: "behavioral",
        validationManifestDigest: null,
        fixtures: Array.from({ length: 65 }, () => summary)
      }).success
    ).toBe(false);
    for (const badSummary of [
      { fixtureId, path: "/etc/passwd", bytes: "120" },
      { fixtureId, path: "tests/greet.test.ts", bytes: "0120" },
      { fixtureId: "c".repeat(63), path: "tests/greet.test.ts", bytes: "120" }
    ]) {
      expect(
        responseResultSchema.safeParse({
          type: "validation_fixtures",
          validationMode: "behavioral",
          validationManifestDigest: null,
          fixtures: [badSummary]
        }).success,
        JSON.stringify(badSummary)
      ).toBe(false);
    }
  });

  it("accepts an empty terminal validation_fixture_chunk and rejects malformed base64", () => {
    const fixtureId = "c".repeat(64);
    const base = { type: "validation_fixture_chunk", fixtureId, offset: "0", eof: true };
    for (const contentBase64 of ["Zm9vYmFy", "", "Zm8=", "Zg==", "a".repeat(10_924)]) {
      expect(
        responseResultSchema.safeParse({ ...base, contentBase64 }).success,
        JSON.stringify(contentBase64.slice(0, 16))
      ).toBe(true);
    }
    for (const contentBase64 of [
      "Zm9vYmF",
      "Zm9v!mFy",
      "Zg===",
      "=Zm9v",
      "Zm8=Zm8=",
      "a".repeat(10_928)
    ]) {
      expect(
        responseResultSchema.safeParse({ ...base, contentBase64 }).success,
        JSON.stringify(contentBase64.slice(0, 16))
      ).toBe(false);
    }
  });

  it("validates change-set and client IDs before retaining ownership", () => {
    const context = new LocalServiceProtocolContext(1, 1);
    const oversized = "x".repeat(513);
    const oversizedUtf8 = "é".repeat(257);

    expect(() => context.recordChangeSetOwner("", "client:alpha")).toThrow(/must not be empty/);
    expect(() => context.recordChangeSetOwner("change:1", "")).toThrow(/must not be empty/);
    expect(() => context.recordChangeSetOwner(oversized, "client:alpha")).toThrow(/exceeds 512/);
    expect(() => context.recordChangeSetOwner("change:1", oversized)).toThrow(/exceeds 512/);
    expect(() => context.recordChangeSetOwner(oversizedUtf8, "client:alpha")).toThrow(/exceeds 512/);
    expect(() => context.recordChangeSetOwner("change:1", "client:alpha")).not.toThrow();
    expect(() => context.recordChangeSetOwner("change:2", "client:alpha")).toThrow(
      /context capacity/
    );
  });
  // The typed client must accept every response the daemon can legitimately
  // produce. A change set may carry up to session.rs's MAX_INTENTS (256)
  // intents, and the Rust response validator is pinned to that same bound
  // (`read_operation_response_accepts_max_intents_boundary`). This is the
  // TypeScript half of that pin; without it the two validators can disagree
  // about what is valid, which is exactly the drift that shipped as a latent
  // defect (the mirror sat at 16 while Rust allowed 256).
  it("accepts a read_operation response carrying the maximum intents the daemon allows", () => {
    const operationResult = (intents: number): unknown => ({
      type: "operation",
      graphGeneration: "7",
      operationId: "operation:1",
      changeSetId: "change:1",
      actor: "client:alpha",
      kind: "rename_symbol",
      reasoning: "Rename the shared user type.",
      affectedNodeIds: ["node:user"],
      renames: [],
      intents: Array.from({ length: intents }, () => ({
        kind: "rename_symbol",
        parametersJson: "{}"
      })),
      publicationDigest: "a".repeat(64)
    });

    // The bound itself, not just self-consistency with it: Rust asserts
    // `MAX_OPERATION_INTENTS == SESSION_MAX_INTENTS` and this is the mirror of
    // that assertion. Without this line the test passes at any value.
    expect(MAX_OPERATION_INTENTS).toBe(256);
    expect(responseResultSchema.safeParse(operationResult(MAX_OPERATION_INTENTS)).success).toBe(
      true
    );
    expect(
      responseResultSchema.safeParse(operationResult(MAX_OPERATION_INTENTS + 1)).success
    ).toBe(false);
  });
  // The mutating/read-only partition is maintained in TWO languages. This
  // fixture is the shared oracle: TypeScript asserts its own predicate and its
  // own schema against it, and the Rust suite asserts `is_mutating` against the
  // same file. An action added to one language and not the other fails a gate
  // here instead of failing in production, where the symptom is obscure -- a
  // read sent with an idempotency key that the daemon then refuses.
  it("matches the shared dual-language action partition exactly", () => {
    const partition = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("fixtures/protocol-v2/action-partition.json", import.meta.url)),
        "utf8"
      )
    ) as { mutating: string[]; readOnly: string[] };

    // No action may be missing from the fixture, and none may be invented.
    expect([...partition.mutating, ...partition.readOnly].sort()).toEqual(
      [...ALL_ACTION_TYPES].sort()
    );
    // ...and no action may appear in both halves.
    for (const type of partition.mutating) {
      expect(partition.readOnly).not.toContain(type);
    }
    for (const type of partition.mutating) {
      expect(isMutatingAction(type)).toBe(true);
    }
    for (const type of partition.readOnly) {
      expect(isMutatingAction(type)).toBe(false);
    }
  });

  // Lane assignment is a SECOND dual-language authority, kept separate from
  // the mutation partition above on purpose. The Rust suite asserts
  // `RequestAction::lane` against this same file.
  it("matches the shared dual-language action lane authority exactly", () => {
    const lanes = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("fixtures/protocol-v2/action-lane.json", import.meta.url)),
        "utf8"
      )
    ) as { work: string[]; observation: string[] };

    expect([...lanes.work, ...lanes.observation].sort()).toEqual([...ALL_ACTION_TYPES].sort());
    for (const type of lanes.work) {
      expect(lanes.observation).not.toContain(type);
      expect(laneForAction(type)).toBe("work");
    }
    for (const type of lanes.observation) {
      expect(laneForAction(type)).toBe("observation");
    }
    // An unknown action has no lane, and saying so beats guessing one.
    expect(() => laneForAction("teleport_declaration")).toThrow();
  });

  // The load-bearing negative, mirrored from the Rust suite: the lane split is
  // NOT the mutation split. `ack_events` mutates (for exactly-once) but rides
  // the observation lane so that read and ack keep their natural ordering.
  // Deriving lanes from `isMutatingAction` would pass every other assertion
  // here and quietly break that ordering.
  it("keeps ack_events mutating but observational", () => {
    expect(isMutatingAction("ack_events")).toBe(true);
    expect(laneForAction("ack_events")).toBe("observation");
    expect(laneForAction("read_events")).toBe(laneForAction("ack_events"));
  });
});
