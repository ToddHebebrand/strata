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
import { modulePathOf, listChildren, type Db } from "@strata-code/store";
import { buildVariantToolServer } from "./perScopeAddParameter";

/**
 * "Equipped" variant tool server — fixes the two legibility gaps the
 * probes found, ENTIRELY lab-side (same tool NAMES → hermetic guard
 * untouched, zero canonical change). This is the creative move the prior
 * "unsatisfiable" framing wrongly ruled out: the lab exists to add exactly
 * this kind of affordance.
 *
 * Honest, NOT scripting: these only expose STRUCTURAL graph facts derivable
 * from the code (a const's name, a node's module/scope) — never the
 * per-scope answer mapping. The agent still must read each scope's config
 * to derive the value and decide the policy; the trapped control still
 * guards contamination at graduation.
 *
 * 1. Variant `find_declarations`: the canonical query maps kind:"variable"
 *    → SQL kind="VariableStatement", but ingest stores `export const X` as
 *    kind "FirstStatement" (same TS SyntaxKind, enum alias). A one-token
 *    mismatch. This also matches "FirstStatement", resolving the const's
 *    name from its child Identifier exactly as canonical does, and attaches
 *    modulePath. (Bug-bridge, lab-side.)
 * 2. Variant `read_node`: canonical result PLUS resolved modulePath/scope
 *    (modulePathOf walks parentId→Module). Removes the attribution
 *    deprivation.
 */

type ToolDef = SdkMcpToolDefinition<any>; // sandbox: SDK generic bound

function scopeFromPath(p: string | null): "server" | "ui" | "other" | null {
  if (!p) return null;
  if (p.includes("/src/server/")) return "server";
  if (p.includes("/src/ui/")) return "ui";
  return "other";
}

function safeModulePath(db: Db, id: string): string | null {
  try {
    return modulePathOf(db, id);
  } catch {
    return null; // additive nav info; absence is informative, not swallowed measurement
  }
}

function parseText(r: { content?: { text?: string }[] }): unknown {
  const t = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function buildEquippedToolServer(
  ctx: StrataSessionContext,
  opts: { variant: boolean }
): McpSdkServerConfigWithInstance & { __labTools: ToolDef[] } {
  const baseTools: ToolDef[] = opts.variant
    ? buildVariantToolServer(ctx).__labTools
    : (createStrataTools(ctx) as ToolDef[]);

  const wrapped = baseTools.map((def): ToolDef => {
    if (def.name === "read_node") {
      const orig = def.handler as (a: unknown, e: unknown) => Promise<any>;
      return {
        ...def,
        handler: async (args: unknown, extra: unknown) => {
          const out = parseText(await orig(args, extra)) as
            | { node?: { id: string }; children?: unknown }
            | null;
          if (out && out.node && typeof out.node.id === "string") {
            const mp = safeModulePath(ctx.db, out.node.id);
            return textResult({
              ...out,
              modulePath: mp,
              scope: scopeFromPath(mp)
            });
          }
          return textResult(out);
        }
      } as ToolDef;
    }

    if (def.name === "find_declarations") {
      const orig = def.handler as (a: unknown, e: unknown) => Promise<any>;
      return {
        ...def,
        handler: async (args: unknown, extra: unknown) => {
          const a = (args ?? {}) as { name?: string; kind?: string };
          const canonical = (parseText(await orig(args, extra)) ??
            []) as { id: string; kind: string; payload: string }[];
          const enriched = canonical.map((d) => ({
            ...d,
            modulePath: safeModulePath(ctx.db, d.id),
            scope: scopeFromPath(safeModulePath(ctx.db, d.id))
          }));

          // Supplemental: surface `export const X` (stored as
          // "FirstStatement"), name-matched via child Identifier exactly
          // like canonical does for the mapped kinds. Only when the caller
          // is after variables (kind unset or "variable").
          if (!a.kind || a.kind === "variable") {
            const rows = ctx.db
              .prepare(
                "SELECT id, kind, payload FROM nodes WHERE kind = 'FirstStatement'"
              )
              .all() as { id: string; kind: string; payload: string }[];
            for (const row of rows) {
              if (a.name) {
                const ident = listChildren(ctx.db, row.id).find(
                  (c) => c.kind === "Identifier"
                );
                if (!ident) continue;
                let text: string;
                try {
                  text = (JSON.parse(ident.payload) as { text: string }).text;
                } catch {
                  continue;
                }
                if (text !== a.name) continue;
              }
              if (enriched.some((e) => e.id === row.id)) continue;
              const mp = safeModulePath(ctx.db, row.id);
              enriched.push({
                id: row.id,
                kind: row.kind,
                payload: row.payload,
                modulePath: mp,
                scope: scopeFromPath(mp)
              });
            }
          }
          return textResult(enriched);
        }
      } as ToolDef;
    }

    return def;
  });

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
