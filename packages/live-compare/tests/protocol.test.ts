import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LocalServiceProtocolContext,
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
  const path = fileURLToPath(new URL(`fixtures/protocol-v1/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function frame(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function rawRejectedFrame(name: (typeof RAW_REJECTED_FIXTURES)[number]): Uint8Array {
  const path = fileURLToPath(
    new URL(`fixtures/protocol-v1/raw-rejected/${name}.json`, import.meta.url)
  );
  return readFileSync(path);
}

function rawAcceptedFrame(name: "reordered-whitespace" | "surrogate-pair"): Uint8Array {
  const path = fileURLToPath(
    new URL(`fixtures/protocol-v1/raw-accepted/${name}.json`, import.meta.url)
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
      declarations: [{ nodeId: "a", kind: "interface", name: "User", moduleId: "m" }]
    });
    expect(result.type).toBe("declarations");
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
});
