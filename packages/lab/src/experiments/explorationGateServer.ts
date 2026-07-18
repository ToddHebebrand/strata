import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import {
  createStrataTools,
  STRATA_SERVER_NAME,
  type StrataSessionContext
} from "@strata-code/agent";
import { buildVariantToolServer } from "./perScopeAddParameter";

/**
 * Exploration-gate at the TOOL-HANDLER layer.
 *
 * Finding from iteration 3: the SDK `canUseTool` hook is inert because the
 * canonical hermetic session runs `permissionMode: "bypassPermissions"`
 * (session.ts) — the SDK never consults canUseTool. So the loop-affordance
 * lever must be enforced where the sandbox legitimately controls behavior:
 * inside the in-process tool server (toolServerFactory). This wraps each
 * read-only tool's handler with a budget; once spent with no
 * `begin_transaction`, the read-only tools return an actionable
 * STOP-and-act instruction instead of data, forcing the agent into the
 * act phase. Mutation/transaction/validate/commit handlers are never
 * gated; once a transaction opens, the gate is inert.
 *
 * Integrity: the instruction text carries NO per-scope value
 * ("UTC"/"local" appear nowhere) — it makes the agent ACT, it does not
 * solve the task. Tool NAMES are unchanged (hermetic guard intact).
 * State is per-process: one CLI run = one fresh gate.
 */
const READONLY = new Set(["find_declarations", "get_references", "read_node"]);

export function buildGatedToolServer(
  ctx: StrataSessionContext,
  opts: { variant: boolean; readBudget?: number }
): McpSdkServerConfigWithInstance & { __labTools: SdkMcpToolDefinition<any>[] } { // sandbox: SDK generic bound
  const readBudget = opts.readBudget ?? 14;
  const baseTools: SdkMcpToolDefinition<any>[] = opts.variant
    ? buildVariantToolServer(ctx).__labTools
    : (createStrataTools(ctx) as SdkMcpToolDefinition<any>[]);

  let reads = 0;
  let txOpen = false;

  const wrapped = baseTools.map((def) => {
    const orig = def.handler as (
      args: unknown,
      extra: unknown
    ) => Promise<{ content: { type: "text"; text: string }[] }>;
    return {
      ...def,
      handler: async (args: unknown, extra: unknown) => {
        if (def.name === "begin_transaction") {
          txOpen = true;
          return orig(args, extra);
        }
        if (!txOpen && READONLY.has(def.name)) {
          reads += 1;
          if (reads > readBudget) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    gate: "exploration-budget-exceeded",
                    reads,
                    message:
                      `Exploration budget spent (${reads} read-only calls, ` +
                      `no transaction opened). STOP exploring. Call ` +
                      `begin_transaction now, then add_parameter on ` +
                      `formatTimestamp — it rewrites every direct callsite ` +
                      `in ONE operation; pass its per_scope option mapping ` +
                      `each module-path prefix to the ZONE import you read ` +
                      `for that scope. Then validate and commit_transaction.`
                  })
                }
              ]
            };
          }
        }
        return orig(args, extra);
      }
    } as SdkMcpToolDefinition<any>;
  });

  const server = createSdkMcpServer({
    name: STRATA_SERVER_NAME,
    version: "0.0.0",
    tools: wrapped
  }) as McpSdkServerConfigWithInstance & {
    __labTools: SdkMcpToolDefinition<any>[];
  };
  Object.defineProperty(server, "__labTools", {
    value: wrapped,
    enumerable: false,
    writable: false
  });
  return server;
}
