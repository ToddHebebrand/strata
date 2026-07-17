import { describe, expect, it } from "vitest";
import {
  COORDINATION_QUALIFIED_TOOL_NAMES,
  COORDINATION_TOOL_INPUT_SCHEMAS,
  COORDINATION_TOOL_NAMES,
  createCoordinationToolServer,
  createCoordinationTools,
  type CoordinationClientApi
} from "../src/tools";

const changeSet = {
  type: "change_set" as const,
  changeSetId: "change:1",
  state: "draft" as const,
  ticketState: null,
  graphGeneration: "0",
  operationId: null,
  affectedNodeIds: [],
  diagnostics: [],
  publicationDigest: null,
  renamedSymbols: []
};

function fakeClient(overrides: Partial<CoordinationClientApi> = {}): CoordinationClientApi {
  return {
    inspectNodes: async () => ({ type: "nodes", graphGeneration: "0", nodes: [] }),
    beginChangeSet: async () => changeSet,
    addIntent: async () => changeSet,
    submitChangeSet: async () => ({ ...changeSet, state: "ready", ticketState: "ready" }),
    advanceChangeSet: async () => ({ ...changeSet, state: "published" }),
    readEvents: async () => ({ type: "events", events: [] }),
    ackEvents: async () => ({ type: "events_acked", throughSequence: "0" }),
    cancelChangeSet: async () => ({ type: "cancelled", changeSetId: "change:1", state: "cancelled" }),
    ...overrides
  };
}

function textPayload(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text === undefined) {
    throw new Error("expected one text result");
  }
  return JSON.parse(first.text);
}

describe("coordination-only MCP surface", () => {
  it("exports exactly the eight design operations and qualified allowlist", () => {
    expect(COORDINATION_TOOL_NAMES).toEqual([
      "inspect_nodes",
      "begin_change_set",
      "add_intent",
      "submit_change_set",
      "advance_change_set",
      "read_events",
      "ack_events",
      "cancel_change_set"
    ]);
    expect(createCoordinationTools(fakeClient()).map((entry) => entry.name)).toEqual(
      COORDINATION_TOOL_NAMES
    );
    expect(COORDINATION_QUALIFIED_TOOL_NAMES).toEqual(
      COORDINATION_TOOL_NAMES.map((name) => `mcp__coordination__${name}`)
    );
  });

  it("describes stable IDs, the lifecycle, events, and bounded fresh decisions without task assignment", () => {
    const descriptions = createCoordinationTools(fakeClient()).map(
      (entry) => entry.description
    );
    const joined = descriptions.join("\n");
    for (const term of [
      "stable node ID",
      "begin_change_set",
      "add_intent",
      "submit_change_set",
      "advance_change_set",
      "read_events",
      "ack_events",
      "cancel_change_set",
      "fresh decision"
    ]) {
      expect(joined).toContain(term);
    }
    expect(joined).not.toMatch(/decompos|assign(?:s|ed|ment)?|other task|other agent/i);
  });

  it("accepts only stable IDs and the two strict typed intent variants", () => {
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.inspect_nodes.parse({
        node_ids: ["node:stable"]
      })
    ).toEqual({ node_ids: ["node:stable"] });
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.add_intent.parse({
        change_set_id: "change:1",
        intent: {
          type: "rename_symbol",
          declaration_id: "node:decl",
          new_name: "Account"
        }
      })
    ).toMatchObject({ intent: { type: "rename_symbol" } });
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.add_intent.parse({
        change_set_id: "change:1",
        intent: {
          type: "add_parameter",
          function_id: "node:function",
          name: "excited",
          type_text: "boolean",
          position: 1,
          value: "false"
        }
      })
    ).toMatchObject({ intent: { type: "add_parameter", value: "false" } });
  });

  it.each([
    "key",
    "resource_key",
    "scope",
    "clock",
    "reservation",
    "tick",
    "claim",
    "fence",
    "attempt",
    "delta",
    "path",
    "command",
    "redb_path",
    "bridge_config"
  ])("rejects banned authority/path/command field %s at every tool boundary", (field) => {
    for (const schema of Object.values(COORDINATION_TOOL_INPUT_SCHEMAS)) {
      expect(schema.safeParse({ [field]: "forbidden" }).success).toBe(false);
    }
  });

  it("rejects extra intent fields, unsupported operations, and per-callsite values", () => {
    const base = { change_set_id: "change:1" };
    for (const intent of [
      { type: "delete_node", node_id: "node:1" },
      { type: "rename_symbol", declaration_id: "node:1", new_name: "X", scope: [] },
      {
        type: "add_parameter",
        function_id: "node:1",
        name: "x",
        type_text: "string",
        position: 0,
        value: '"same"',
        callsite_values: { call: '"different"' }
      }
    ]) {
      expect(
        COORDINATION_TOOL_INPUT_SCHEMAS.add_intent.safeParse({ ...base, intent }).success
      ).toBe(false);
    }
  });

  it("keeps strict unknown-field rejection in the actual MCP registry", () => {
    const server = createCoordinationToolServer(fakeClient()) as unknown as {
      instance: {
        _registeredTools: Record<
          string,
          { inputSchema: { safeParse(value: unknown): { success: boolean } } }
        >;
      };
    };
    const valid: Record<string, Record<string, unknown>> = {
      inspect_nodes: { node_ids: ["node:1"] },
      begin_change_set: { reasoning: "reason" },
      add_intent: {
        change_set_id: "change:1",
        intent: {
          type: "rename_symbol",
          declaration_id: "node:1",
          new_name: "Account"
        }
      },
      submit_change_set: { change_set_id: "change:1" },
      advance_change_set: { change_set_id: "change:1" },
      read_events: { after_sequence: "0", limit: 10 },
      ack_events: { through_sequence: "0" },
      cancel_change_set: { change_set_id: "change:1" }
    };

    for (const [name, registered] of Object.entries(
      server.instance._registeredTools
    )) {
      expect(
        registered.inputSchema.safeParse({
          ...valid[name],
          redb_path: "/forbidden/canonical.redb"
        }).success,
        name
      ).toBe(false);
    }
  });

  it("maps safe tool arguments to protocol-shaped client calls", async () => {
    const calls: unknown[] = [];
    const tools = createCoordinationTools(
      fakeClient({
        addIntent: async (...args) => {
          calls.push(args);
          return changeSet;
        }
      })
    );
    const add = tools.find((entry) => entry.name === "add_intent")!;

    const result = textPayload(
      await add.handler(
        {
          change_set_id: "change:1",
          intent: {
            type: "rename_symbol",
            declaration_id: "node:decl",
            new_name: "Account"
          }
        },
        {}
      )
    );

    expect(calls).toEqual([
      [
        "change:1",
        { type: "rename_symbol", declarationId: "node:decl", newName: "Account" }
      ]
    ]);
    expect(result).toEqual(changeSet);
  });

  it("adds bounded fresh-decision guidance without exposing hidden work", async () => {
    const needsDecision = {
      ...changeSet,
      state: "needs_decision" as const,
      ticketState: "needs_decision" as const,
      affectedNodeIds: ["node:known"]
    };
    const advance = createCoordinationTools(
      fakeClient({ advanceChangeSet: async () => needsDecision })
    ).find((entry) => entry.name === "advance_change_set")!;

    const result = textPayload(
      await advance.handler({ change_set_id: "change:1" }, {})
    ) as { guidance: string };

    expect(result).toMatchObject(needsDecision);
    expect(result.guidance).toContain("inspect_nodes");
    expect(result.guidance).toContain("cancel_change_set");
    expect(result.guidance).toContain("new typed change set");
    expect(result.guidance).not.toMatch(/other task|other agent|hidden/i);
  });
});
