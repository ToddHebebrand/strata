import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { CoordinationIntent, CoordinationResult } from "./client.js";

const MAX_ID_CHARS = 512;
const MAX_REASONING_CHARS = 4_096;
const MAX_TEXT_CHARS = 16_384;
const MAX_NODE_IDS = 256;
const MAX_EVENT_LIMIT = 256;

const stableId = z.string().min(1).max(MAX_ID_CHARS).describe("Stable node or change-set ID.");
const canonicalSequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .describe("Canonical unsigned event sequence returned by the service.");

const renameIntent = z
  .object({
    type: z.literal("rename_symbol"),
    declaration_id: stableId,
    new_name: z.string().min(1).max(MAX_ID_CHARS)
  })
  .strict();

const addParameterIntent = z
  .object({
    type: z.literal("add_parameter"),
    function_id: stableId,
    name: z.string().min(1).max(MAX_ID_CHARS),
    type_text: z.string().max(MAX_TEXT_CHARS),
    position: z.number().int().min(0).max(0xffff_ffff),
    value: z
      .string()
      .max(MAX_TEXT_CHARS)
      .describe("One uniform value expression applied to every direct callsite.")
  })
  .strict();

export const COORDINATION_TOOL_INPUT_SCHEMAS = {
  find_declarations: z
    .object({
      name: z.string().min(1).max(MAX_ID_CHARS),
      kind: z.enum(["interface", "type-alias", "class", "function", "variable"]).optional()
    })
    .strict(),
  inspect_nodes: z.object({ node_ids: z.array(stableId).min(1).max(MAX_NODE_IDS) }).strict(),
  begin_change_set: z.object({ reasoning: z.string().max(MAX_REASONING_CHARS) }).strict(),
  add_intent: z
    .object({
      change_set_id: stableId,
      intent: z.discriminatedUnion("type", [renameIntent, addParameterIntent])
    })
    .strict(),
  submit_change_set: z.object({ change_set_id: stableId }).strict(),
  advance_change_set: z.object({ change_set_id: stableId }).strict(),
  read_events: z
    .object({
      after_sequence: canonicalSequence,
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT)
    })
    .strict(),
  ack_events: z.object({ through_sequence: canonicalSequence }).strict(),
  cancel_change_set: z.object({ change_set_id: stableId }).strict()
} as const;

export interface CoordinationClientApi {
  findDeclarations(name: string, kind?: string): Promise<CoordinationResult>;
  inspectNodes(nodeIds: string[]): Promise<CoordinationResult>;
  beginChangeSet(reasoning: string): Promise<CoordinationResult>;
  addIntent(changeSetId: string, intent: CoordinationIntent): Promise<CoordinationResult>;
  submitChangeSet(changeSetId: string): Promise<CoordinationResult>;
  advanceChangeSet(changeSetId: string): Promise<CoordinationResult>;
  readEvents(afterSequence: string, limit: number): Promise<CoordinationResult>;
  ackEvents(throughSequence: string): Promise<CoordinationResult>;
  cancelChangeSet(changeSetId: string): Promise<CoordinationResult>;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function strictTool(
  name: string,
  description: string,
  schema: z.ZodObject,
  handler: (args: any) => Promise<ReturnType<typeof textResult>>
): SdkMcpToolDefinition<any> {
  return {
    name,
    description,
    // The Agent SDK helper accepts only a raw shape and rebuilds a stripping
    // object. Passing the complete strict object preserves fail-closed unknown
    // field handling in the actual MCP registry.
    inputSchema: schema as any,
    handler: async (args) => handler(schema.parse(args))
  } as SdkMcpToolDefinition<any>;
}

function wireIntent(
  intent: z.infer<(typeof COORDINATION_TOOL_INPUT_SCHEMAS)["add_intent"]>["intent"]
): CoordinationIntent {
  return intent.type === "rename_symbol"
    ? {
        type: "rename_symbol",
        declarationId: intent.declaration_id,
        newName: intent.new_name
      }
    : {
        type: "add_parameter",
        functionId: intent.function_id,
        name: intent.name,
        typeText: intent.type_text,
        position: intent.position,
        value: intent.value
      };
}

function withFreshDecisionGuidance(result: CoordinationResult): unknown {
  if (result.type !== "change_set" || result.state !== "needs_decision") return result;
  return {
    ...result,
    guidance:
      "A fresh decision is required. renamedSymbols lists every symbol renamed since your change set's analysis, with its previous and current name; if any intent content (such as an add_parameter value) mentions a previous name, rewrite that text to the current name. Then cancel_change_set for this obsolete change set and begin, add intents to, and submit a new typed change set from current state. Use inspect_nodes only on a bounded set of stable IDs you already have."
  };
}

export function createCoordinationTools(
  client: CoordinationClientApi
): SdkMcpToolDefinition<any>[] {
  return [
    strictTool(
      "find_declarations",
      "Find declarations by exact name, optionally narrowed by kind (interface, type-alias, class, function, variable). Returns stable node IDs with their module. This is your discovery entry point: use it to locate the declaration to change, then inspect_nodes on the returned IDs before mutating.",
      COORDINATION_TOOL_INPUT_SCHEMAS.find_declarations,
      async ({ name, kind }) => textResult(await client.findDeclarations(name, kind))
    ),
    strictTool(
      "inspect_nodes",
      "Inspect a bounded caller-supplied set of stable node IDs and their immediate safe relationships. Read-only. Use stable node IDs from the prompt or prior safe results; do not guess IDs. This is the bounded inspection step before begin_change_set or after a fresh decision.",
      COORDINATION_TOOL_INPUT_SCHEMAS.inspect_nodes,
      async ({ node_ids }) => textResult(await client.inspectNodes(node_ids))
    ),
    strictTool(
      "begin_change_set",
      "Begin an actor-bound draft change set with reasoning. The lifecycle is begin_change_set, add_intent, submit_change_set, then advance_change_set; retain the returned change-set ID.",
      COORDINATION_TOOL_INPUT_SCHEMAS.begin_change_set,
      async ({ reasoning }) => textResult(await client.beginChangeSet(reasoning))
    ),
    strictTool(
      "add_intent",
      "Add one typed rename_symbol or uniform-value add_parameter intent to a draft returned by begin_change_set. Targets are stable node IDs. Add all related intents before submit_change_set; uniform means one value is applied to every resolved direct callsite.",
      COORDINATION_TOOL_INPUT_SCHEMAS.add_intent,
      async ({ change_set_id, intent }) =>
        textResult(await client.addIntent(change_set_id, wireIntent(intent)))
    ),
    strictTool(
      "submit_change_set",
      "Submit a completed draft for fresh structural analysis and scheduling. After submit_change_set, use advance_change_set to ask the service to progress ready work and use read_events for durable lifecycle observations.",
      COORDINATION_TOOL_INPUT_SCHEMAS.submit_change_set,
      async ({ change_set_id }) => textResult(await client.submitChangeSet(change_set_id))
    ),
    strictTool(
      "advance_change_set",
      "Ask the service to advance submitted work from current state. It may publish, queue, report validation failure, or require a fresh decision. On needs_decision, inspect only bounded known stable IDs, cancel_change_set for obsolete work, and create and submit a new typed change set.",
      COORDINATION_TOOL_INPUT_SCHEMAS.advance_change_set,
      async ({ change_set_id }) =>
        textResult(withFreshDecisionGuidance(await client.advanceChangeSet(change_set_id)))
    ),
    strictTool(
      "read_events",
      "Read a bounded page of durable coordination events after a previously observed sequence. Use read_events to observe submitted or advanced work, then ack_events through the last sequence you handled.",
      COORDINATION_TOOL_INPUT_SCHEMAS.read_events,
      async ({ after_sequence, limit }) =>
        textResult(await client.readEvents(after_sequence, limit))
    ),
    strictTool(
      "ack_events",
      "Acknowledge durable events already returned by read_events through one canonical sequence. Acknowledge only sequences you actually received.",
      COORDINATION_TOOL_INPUT_SCHEMAS.ack_events,
      async ({ through_sequence }) => textResult(await client.ackEvents(through_sequence))
    ),
    strictTool(
      "cancel_change_set",
      "Cancel an obsolete change set and release its scheduled work. Use cancel_change_set before beginning replacement work after a fresh decision; terminal published work remains terminal.",
      COORDINATION_TOOL_INPUT_SCHEMAS.cancel_change_set,
      async ({ change_set_id }) => textResult(await client.cancelChangeSet(change_set_id))
    )
  ];
}

export const COORDINATION_TOOL_NAMES = [
  "find_declarations",
  "inspect_nodes",
  "begin_change_set",
  "add_intent",
  "submit_change_set",
  "advance_change_set",
  "read_events",
  "ack_events",
  "cancel_change_set"
] as const;

export const COORDINATION_SERVER_NAME = "coordination" as const;
export const COORDINATION_QUALIFIED_TOOL_NAMES = COORDINATION_TOOL_NAMES.map(
  (name) => `mcp__${COORDINATION_SERVER_NAME}__${name}`
);

export function createCoordinationToolServer(
  client: CoordinationClientApi
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: COORDINATION_SERVER_NAME,
    version: "1.0.0",
    tools: createCoordinationTools(client)
  });
}
