import {
  tool,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

/**
 * BS4 probe: prove the Agent SDK accepts the schema shapes Strata tools need.
 *
 * Phase 1 does not ship an agent. This command exists to make the future
 * Phase 3 tool surface fail at build time if TxHandle, NodeId, or Diagnostic[]
 * stop fitting the SDK's typed tool schema.
 */

const nodeIdSchema = z
  .string()
  .min(1)
  .describe("Stable Strata graph node ID.");

const txHandleSchema = z
  .object({
    id: z.string().min(1).describe("Open transaction ID."),
    actor: z.string().min(1).describe("Actor that opened the transaction.")
  })
  .describe("Strata transaction handle.");

const diagnosticSchema = z.object({
  nodeId: nodeIdSchema.nullable(),
  modulePath: z.string().nullable(),
  message: z.string(),
  code: z.number().int()
});

const findDeclarationsInputSchema = {
  tx: txHandleSchema.optional(),
  name: z.string().optional(),
  kind: z
    .enum(["interface", "type-alias", "class", "function", "variable"])
    .optional(),
  afterDiagnostics: z.array(diagnosticSchema).optional(),
  relatedNodeIds: z.array(nodeIdSchema).optional()
};

export interface SdkToolShape {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export function createFindDeclarationsToolDefinition(): SdkMcpToolDefinition<
  typeof findDeclarationsInputSchema
> {
  return tool(
    "find_declarations",
    "Find declaration nodes by name and/or kind. The schema includes the Phase 3 handle and diagnostic shapes needed around structural operations.",
    findDeclarationsInputSchema,
    async () => ({
      content: [{ type: "text" as const, text: "[]" }]
    })
  );
}

export function describeSdkToolSchema(): SdkToolShape {
  const definition = createFindDeclarationsToolDefinition();
  return {
    name: definition.name,
    description: definition.description,
    input_schema: {
      type: "object",
      required: [],
      properties: {
        tx: {
          type: "object",
          description: "TxHandle",
          properties: {
            id: { type: "string" },
            actor: { type: "string" }
          }
        },
        name: { type: "string" },
        kind: {
          type: "string",
          enum: ["interface", "type-alias", "class", "function", "variable"]
        },
        afterDiagnostics: {
          type: "array",
          description: "Diagnostic[]",
          items: {
            type: "object",
            properties: {
              nodeId: { anyOf: [{ type: "string" }, { type: "null" }] },
              modulePath: { anyOf: [{ type: "string" }, { type: "null" }] },
              message: { type: "string" },
              code: { type: "number" }
            }
          }
        },
        relatedNodeIds: {
          type: "array",
          description: "NodeId[]",
          items: { type: "string" }
        }
      }
    }
  };
}
