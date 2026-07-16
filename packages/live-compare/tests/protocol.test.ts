import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LocalServiceProtocolContext,
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  parseRequestFrame,
  parseResponseFrame,
  serializeRequestFrame,
  serializeResponseFrame
} from "../src/index";

type Direction = "request" | "response";
type FixtureCase = { name: string; direction: Direction; value: unknown };

function fixture<T>(name: "accepted" | "rejected"): T {
  const path = fileURLToPath(new URL(`fixtures/protocol-v1/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function frame(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
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

  it("rejects every shared invalid request or response", () => {
    const rejected = fixture<{ cases: FixtureCase[] }>("rejected");
    for (const testCase of rejected.cases) {
      const parse = testCase.direction === "request" ? parseRequestFrame : parseResponseFrame;
      expect(() => parse(frame(testCase.value)), testCase.name).toThrow();
    }
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
});
