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
    findDeclarations: async () => ({
      type: "declarations",
      graphGeneration: "0",
      declarations: [],
      hasMore: false
    }),
    listModules: async () => ({
      type: "modules",
      graphGeneration: "0",
      modules: [],
      hasMore: false
    }),
    listModuleDeclarations: async () => ({
      type: "module_declarations",
      graphGeneration: "0",
      declarations: [],
      hasMore: false
    }),
    getReferences: async () => ({
      type: "references",
      graphGeneration: "0",
      references: [],
      hasMore: false
    }),
    inspectNodes: async () => ({ type: "nodes", graphGeneration: "0", nodes: [] }),
    beginChangeSet: async () => changeSet,
    addIntent: async () => changeSet,
    submitChangeSet: async () => ({ ...changeSet, state: "ready", ticketState: "ready" }),
    advanceChangeSet: async () => ({ ...changeSet, state: "published" }),
    readEvents: async () => ({ type: "events", events: [] }),
    ackEvents: async () => ({ type: "events_acked", throughSequence: "0" }),
    cancelChangeSet: async () => ({ type: "cancelled", changeSetId: "change:1", state: "cancelled" }),
    readOperation: async () => ({
      type: "operation",
      graphGeneration: "1",
      operationId: "operation:1",
      changeSetId: "change:1",
      actor: "client:alpha",
      kind: "RenameSymbol",
      reasoning: "reason",
      affectedNodeIds: ["node:decl"],
      renames: [{ nodeId: "node:decl", fromName: "User", toName: "Account" }],
      intents: [
        {
          kind: "RenameSymbol",
          parametersJson: '{"type":"renameSymbol","declarationId":"node:decl","newName":"Account"}'
        }
      ],
      publicationDigest: "a".repeat(64)
    }),
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
  it("exports exactly the thirteen design operations and qualified allowlist", () => {
    expect(COORDINATION_TOOL_NAMES).toEqual([
      "list_modules",
      "list_module_declarations",
      "find_declarations",
      "inspect_nodes",
      "get_references",
      "begin_change_set",
      "add_intent",
      "submit_change_set",
      "advance_change_set",
      "read_events",
      "read_operation",
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
      "read_operation",
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

  it("accepts paged find_declarations narrowing by module_id and after_node_id", () => {
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.find_declarations.parse({
        name: "Account",
        kind: "class",
        module_id: "module:1",
        after_node_id: "node:99"
      })
    ).toEqual({
      name: "Account",
      kind: "class",
      module_id: "module:1",
      after_node_id: "node:99"
    });
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.find_declarations.safeParse({
        name: "Account",
        extra: "nope"
      }).success
    ).toBe(false);
  });

  it("bounds list_modules to a page of at most 64 with an optional cursor", () => {
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_modules.parse({ limit: 64 })
    ).toEqual({ limit: 64 });
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_modules.parse({
        after_module_id: "module:1",
        limit: 1
      })
    ).toEqual({ after_module_id: "module:1", limit: 1 });
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_modules.safeParse({ limit: 0 }).success
    ).toBe(false);
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_modules.safeParse({ limit: 65 }).success
    ).toBe(false);
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_modules.safeParse({ limit: 10, extra: "nope" })
        .success
    ).toBe(false);
  });

  it("requires module_id and bounds list_module_declarations to a page of at most 64", () => {
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_module_declarations.parse({
        module_id: "module:1",
        limit: 64
      })
    ).toEqual({ module_id: "module:1", limit: 64 });
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_module_declarations.safeParse({ limit: 10 }).success
    ).toBe(false);
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_module_declarations.safeParse({
        module_id: "module:1",
        limit: 65
      }).success
    ).toBe(false);
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.list_module_declarations.safeParse({
        module_id: "module:1",
        limit: 0
      }).success
    ).toBe(false);
  });

  it("requires node_id and bounds get_references to a page of at most 256", () => {
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.get_references.parse({
        node_id: "node:1",
        limit: 256
      })
    ).toEqual({ node_id: "node:1", limit: 256 });
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.get_references.safeParse({ limit: 10 }).success
    ).toBe(false);
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.get_references.safeParse({
        node_id: "node:1",
        limit: 257
      }).success
    ).toBe(false);
    expect(
      COORDINATION_TOOL_INPUT_SCHEMAS.get_references.safeParse({
        node_id: "node:1",
        limit: 0
      }).success
    ).toBe(false);
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
      list_modules: { limit: 10 },
      list_module_declarations: { module_id: "module:1", limit: 10 },
      find_declarations: { name: "Account" },
      inspect_nodes: { node_ids: ["node:1"] },
      get_references: { node_id: "node:1", limit: 10 },
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
      read_operation: { operation_id: "operation:1" },
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

  it("forwards paged find_declarations args, omitting unset optionals", async () => {
    const calls: unknown[] = [];
    const tools = createCoordinationTools(
      fakeClient({
        findDeclarations: async (...args) => {
          calls.push(args);
          return { type: "declarations", graphGeneration: "0", declarations: [], hasMore: false };
        }
      })
    );
    const find = tools.find((entry) => entry.name === "find_declarations")!;

    await find.handler({ name: "Account" }, {});
    await find.handler(
      { name: "Account", kind: "class", module_id: "module:1", after_node_id: "node:9" },
      {}
    );

    expect(calls).toEqual([
      ["Account", {}],
      ["Account", { kind: "class", moduleId: "module:1", afterNodeId: "node:9" }]
    ]);
  });

  it("forwards list_modules args to the client, omitting the cursor when unset", async () => {
    const calls: unknown[] = [];
    const tools = createCoordinationTools(
      fakeClient({
        listModules: async (...args) => {
          calls.push(args);
          return { type: "modules", graphGeneration: "0", modules: [], hasMore: false };
        }
      })
    );
    const listModules = tools.find((entry) => entry.name === "list_modules")!;

    await listModules.handler({ limit: 10 }, {});
    await listModules.handler({ after_module_id: "module:1", limit: 5 }, {});

    expect(calls).toEqual([
      [undefined, 10],
      [{ afterModuleId: "module:1" }, 5]
    ]);
  });

  it("forwards list_module_declarations args to the client, omitting the cursor when unset", async () => {
    const calls: unknown[] = [];
    const tools = createCoordinationTools(
      fakeClient({
        listModuleDeclarations: async (...args) => {
          calls.push(args);
          return {
            type: "module_declarations",
            graphGeneration: "0",
            declarations: [],
            hasMore: false
          };
        }
      })
    );
    const listModuleDeclarations = tools.find(
      (entry) => entry.name === "list_module_declarations"
    )!;

    await listModuleDeclarations.handler({ module_id: "module:1", limit: 10 }, {});
    await listModuleDeclarations.handler(
      { module_id: "module:1", after_node_id: "node:1", limit: 5 },
      {}
    );

    expect(calls).toEqual([
      ["module:1", undefined, 10],
      ["module:1", { afterNodeId: "node:1" }, 5]
    ]);
  });

  it("forwards get_references args to the client, omitting the cursor when unset", async () => {
    const calls: unknown[] = [];
    const tools = createCoordinationTools(
      fakeClient({
        getReferences: async (...args) => {
          calls.push(args);
          return { type: "references", graphGeneration: "0", references: [], hasMore: false };
        }
      })
    );
    const getReferences = tools.find((entry) => entry.name === "get_references")!;

    await getReferences.handler({ node_id: "node:1", limit: 10 }, {});
    await getReferences.handler(
      { node_id: "node:1", after_reference_key: "node:2", limit: 5 },
      {}
    );

    expect(calls).toEqual([
      ["node:1", undefined, 10],
      ["node:1", { afterReferenceKey: "node:2" }, 5]
    ]);
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
