import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import { STRATA_SERVER_NAME, type StrataSessionContext } from "@strata/agent";
import { buildEquippedToolServer } from "./equippedToolServer";
import type { LabExperiment } from "../experiment";
import { HD_DIRECTIVE_PROMPT } from "./directivePrompt";

/**
 * Iteration 6 — the decisive test. Equipped (legible) tools, the per-scope
 * add_parameter variant, the directive prompt, AND the tool-handler
 * exploration-gate. The equipped run proved the agent now has every fact
 * it needs (function id, each callsite + modulePath, the ZONE const) yet
 * still never opens a transaction. This forces the act transition when the
 * instrument is demonstrably adequate — isolating "won't act even fully
 * equipped + forced" (a genuine act-phase failure, instrument-confound
 * removed) from "needed more exploration".
 *
 * Honest: the gate message says STOP exploring + how to use the tools; it
 * carries NO per-scope value. Trapped control still guards contamination.
 */
const READONLY = new Set(["find_declarations", "get_references", "read_node"]);
type ToolDef = SdkMcpToolDefinition<any>; // sandbox: SDK generic bound

function gateWrap(tools: ToolDef[], readBudget: number): ToolDef[] {
  let reads = 0;
  let txOpen = false;
  return tools.map((def): ToolDef => {
    const orig = def.handler as (a: unknown, e: unknown) => Promise<any>;
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
                      `Budget spent (${reads} read-only calls, no ` +
                      `transaction). You already have: the formatTimestamp ` +
                      `function id, every callsite with its modulePath/scope ` +
                      `(from get_references + read_node), and the per-scope ` +
                      `ZONE constants (find_declarations kind:"variable"). ` +
                      `STOP reading. Call begin_transaction, then ` +
                      `add_parameter on formatTimestamp with a per_scope map ` +
                      `keyed by module-path prefix, then validate and ` +
                      `commit_transaction.`
                  })
                }
              ]
            };
          }
        }
        return orig(args, extra);
      }
    } as ToolDef;
  });
}

function buildEquippedGated(
  ctx: StrataSessionContext
): McpSdkServerConfigWithInstance & { __labTools: ToolDef[] } {
  const equipped = buildEquippedToolServer(ctx, { variant: true }).__labTools;
  const wrapped = gateWrap(equipped, 16);
  const server = createSdkMcpServer({
    name: STRATA_SERVER_NAME,
    version: "0.0.0",
    tools: wrapped
  }) as McpSdkServerConfigWithInstance & { __labTools: ToolDef[] };
  Object.defineProperty(server, "__labTools", {
    value: wrapped,
    enumerable: false,
    writable: false
  });
  return server;
}

export const perScopeEquippedGated: LabExperiment = {
  id: "per-scope-equipped-gated",
  hypothesis:
    "equipped legible tools + per-scope add_parameter + directive prompt + " +
    "exploration-gate — forces the act transition when the agent provably " +
    "already has every needed fact; isolates a genuine act-phase failure " +
    "from a legibility/exploration confound.",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildEquippedGated(ctx),
    prompt: HD_DIRECTIVE_PROMPT
  }
};
