import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  add_parameter,
  begin,
  commitWithoutValidate,
  find_declarations,
  insertNodes,
  insertReferences,
  listOperationsByTx,
  listModules,
  loadModule,
  modulePathOf,
  openDb,
  resolveCallsites
} from "@strata-code/store";
import { renderWithSourceMap } from "@strata-code/render";
import {
  applyPerScopeAddParameter,
  buildVariantToolServer,
  perScopeAddParameter
} from "../src/experiments/perScopeAddParameter";

// ---------------------------------------------------------------------------
// Model-FREE mechanics test. Drives the variant `add_parameter` tool handler
// DIRECTLY (no SDK / no model) over an in-memory store built from the lab
// corpus, and proves the lever's thesis: per-scope differentiation is
// expressed by the TOOL as ONE structural operation — zero `oldText
// mismatch`, exactly ONE add_parameter operation-log row, NO second
// replace_body-style text edit.
// ---------------------------------------------------------------------------

const CORPUS_ROOT = path.join(__dirname, "..", "corpus");
const SRC_ROOT = path.join(CORPUS_ROOT, "src");

// DRY: same collect/ingest/insert idiom as packages/agent/src/session.ts
// runAgentForPrompt (collectTsFiles → ingestBatch → insertNodes →
// insertReferences) and packages/lab/test/experiment.test.ts buildCorpusStore.
function collectTsFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d).sort()) {
      const abs = path.join(d, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts"))
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
    }
  }
  walk(dir);
  return out;
}

function buildCorpusStore(): ReturnType<typeof openDb> {
  const batch = ingestBatch(collectTsFiles(SRC_ROOT));
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

/** Render every committed module to src/-prefixed POSIX keys (same idiom as
 *  experiment.ts renderCommittedSrc) so per-scope arg presence is checked
 *  against the actual rendered text, not the overlay. */
function renderCommitted(db: ReturnType<typeof openDb>): Map<string, string> {
  const out = new Map<string, string>();
  for (const module of listModules(db)) {
    const loaded = loadModule(db, module.id);
    const text = renderWithSourceMap(loaded.module, loaded.children).text;
    const key = path
      .relative(CORPUS_ROOT, module.payload)
      .replaceAll("\\", "/");
    out.set(key, text);
  }
  return out;
}

/** Extract the single SdkMcpToolDefinition the variant server exposes for a
 *  given tool name, reaching through the McpSdkServerConfigWithInstance. */
function toolDef(server: any, name: string): any {
  // createSdkMcpServer returns { type, name, instance }. The tool list is
  // captured in closure; the lab variant also exposes the raw definitions
  // via a non-enumerable `__labTools` for deterministic model-free testing.
  const tools = server.__labTools as any[];
  const def = tools.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not found in variant server`);
  return def;
}

describe("per-scope add_parameter mechanics (model-free)", () => {
  it(
    // (d) deterministic & model-free: this entire suite drives tool handlers
    // directly, no SDK query loop, no API key needed.
    "(d) does not require a live model: no API key, pure store + tool handler",
    () => {
      // Prove the experiment wires a synchronous server factory, not a model
      // loop — the presence of toolServerFactory on the experiment is the
      // structural proof that the variant server replaces the SDK model path.
      expect(perScopeAddParameter.overrides.toolServerFactory).toBeTypeOf(
        "function"
      );
    }
  );

  it("variant set keeps tool NAME add_parameter and drops the canonical one", () => {
    const db = buildCorpusStore();
    try {
      const server = buildVariantToolServer({ db, actor: "mech-test" });
      const tools = server.__labTools as any[];
      const names = tools.map((t) => t.name);
      // Exactly one add_parameter (the variant), same NAME (hermetic-safe).
      expect(names.filter((n) => n === "add_parameter")).toHaveLength(1);
      // No net-new tool name was introduced.
      expect(names.slice().sort()).toEqual(
        [
          "add_parameter",
          "begin_transaction",
          "change_return_type",
          "commit_transaction",
          "find_declarations",
          "get_references",
          "read_node",
          "rename_symbol",
          "replace_body",
          "rollback_transaction",
          "validate"
        ].sort()
      );
    } finally {
      db.close();
    }
  });

  it(
    "(a)(b)(c) one structural op: signature param + per-scope callsite args, " +
      "zero oldText mismatch, exactly ONE add_parameter op-log row, no 2nd edit",
    async () => {
      const db = buildCorpusStore();
      try {
        const ctx = { db, actor: "mech-test" };
        const server = buildVariantToolServer(ctx);
        const beginDef = toolDef(server, "begin_transaction");
        const addDef = toolDef(server, "add_parameter");

        // formatTimestamp declaration node id (FunctionDeclaration).
        const fn = find_declarations(db, {
          name: "formatTimestamp",
          kind: "function"
        });
        expect(fn).toHaveLength(1);
        const functionId = fn[0]!.id;

        // Sanity: canonical callsite resolution sees 5 direct callsites
        // (2 server, 2 ui [firstRow + timelineRows' arrow], 1 lib/other)
        // before any mutation.
        const pre = resolveCallsites(db, functionId);
        const preScopes = pre.callsites.map((c) => {
          const mp = modulePathOf(db, c.statementId);
          return mp.includes("/server/")
            ? "server"
            : mp.includes("/ui/")
              ? "ui"
              : "other";
        });
        expect(preScopes.sort()).toEqual(
          ["other", "server", "server", "ui", "ui"].sort()
        );

        // begin_transaction via the variant server's own tool. Handlers
        // are async (return a CallToolResult Promise) — resolve them.
        {
          const txText = (await beginDef.handler({}, {})).content[0].text;
          const tx = JSON.parse(txText) as { id: string; actor: string };

          // Invoke the VARIANT add_parameter with a per_scope policy:
          // module-path prefix → argument expression. server/ + ui/ get the
          // imported ZONE; everything else takes the canonical default.
          const addText = (
            await addDef.handler(
              {
                tx,
                function_id: functionId,
                name: "timezone",
                type: "string",
                position: 1,
                default: '"UTC"',
                per_scope: {
                  "src/server/": "ZONE",
                  "src/ui/": "ZONE"
                }
              },
              {}
            )
          ).content[0].text;
          const manifest = JSON.parse(addText) as {
            ok: boolean;
            callsitesRewritten: {
              modulePath: string;
              statementId: string;
            }[];
            arityRiskSites: unknown[];
          };
          expect(manifest.ok).toBe(true);
          // (b) every direct callsite rewritten (5), none skipped.
          expect(manifest.callsitesRewritten).toHaveLength(5);

          // Commit the overlay. (c) commitWithoutValidate THROWS on any
          // `oldText mismatch` (see transactions.ts) — reaching this line
          // without a throw is the zero-mismatch proof. We also assert no
          // exception explicitly.
          let commitThrew: unknown;
          try {
            commitWithoutValidate(db, tx as any);
          } catch (e) {
            commitThrew = e;
          }
          expect(commitThrew).toBeUndefined();

          // (c) EXACTLY ONE operation-log row, kind AddParameter — i.e. the
          // per-scope differentiation did NOT require a second
          // replace_body / text-span operation.
          const ops = listOperationsByTx(db, tx.id);
          expect(ops).toHaveLength(1);
          expect(ops[0]!.kind).toBe("AddParameter");

          // (a) the declaration signature got the new parameter.
          const rendered = renderCommitted(db);
          const formatSrc = rendered.get("src/lib/format.ts")!;
          expect(formatSrc).toMatch(
            /function formatTimestamp\(\s*ts: number,\s*timezone: string = "UTC"\s*\)/
          );

          // (b) per-scope argument differentiation at the callsites:
          //   server-scope callsites → ZONE
          const serverSrc = rendered.get("src/server/events.ts")!;
          expect(serverSrc).toMatch(/formatTimestamp\(at,\s*ZONE\)/);
          // logEvent + eventLine both rewritten (2 server callsites).
          expect(
            (serverSrc.match(/formatTimestamp\([^)]*ZONE\)/g) ?? []).length
          ).toBe(2);
          //   ui-scope callsites → ZONE (firstRow's `(0)` + timelineRows'
          //   arrow `(t)`, 2 ui callsites in this module).
          const uiSrc = rendered.get("src/ui/timeline.ts")!;
          expect(uiSrc).toMatch(/formatTimestamp\(0,\s*ZONE\)/);
          expect(uiSrc).toMatch(/formatTimestamp\(t,\s*ZONE\)/);
          expect(
            (uiSrc.match(/formatTimestamp\([^)]*ZONE\)/g) ?? []).length
          ).toBe(2);
          //   other-scope callsite → canonical default ("UTC"), NOT ZONE
          const otherSrc = rendered.get("src/lib/startupStamp.ts")!;
          expect(otherSrc).toMatch(/formatTimestamp\(0,\s*"UTC"\)/);
          expect(otherSrc).not.toMatch(/ZONE/);
        }
      } finally {
        db.close();
      }
    }
  );

  it(
    "faithfulness pin: empty per_scope == canonical add_parameter " +
      "(guards applyPerScopeAddParameter against silent drift from @strata-code/store)",
    () => {
      // Two INDEPENDENT in-memory stores from the SAME corpus. Store A uses
      // the canonical exported add_parameter op; store B uses
      // applyPerScopeAddParameter with NO per_scope policy. Their committed
      // rendered src/ text maps must be byte-equal, AND both must produce
      // exactly ONE AddParameter op row. This test FAILS if the lab copy
      // drifts from canonical on the no-per_scope path.
      //
      // Canonical add_parameter IS exported from @strata-code/store (confirmed in
      // packages/store/src/index.ts) — pin test is feasible without any deep
      // import or canonical modification.
      const dbA = buildCorpusStore();
      const dbB = buildCorpusStore();
      try {
        const fn = find_declarations(dbA, {
          name: "formatTimestamp",
          kind: "function"
        });
        expect(fn).toHaveLength(1);
        const functionId = fn[0]!.id;

        // Store A: canonical add_parameter
        const txA = begin(dbA, "pin-test-canonical");
        add_parameter(dbA, txA, functionId, "timezone", "string", 1, '"UTC"');
        commitWithoutValidate(dbA, txA);

        // Store B: lab copy with NO per_scope (empty/undefined → fallback path
        // must match canonical for every callsite)
        const txB = begin(dbB, "pin-test-lab");
        applyPerScopeAddParameter(
          dbB,
          txB,
          functionId,
          "timezone",
          "string",
          1,
          '"UTC"',
          undefined // no per_scope → must behave identically to canonical
        );
        commitWithoutValidate(dbB, txB);

        // Both must produce exactly ONE AddParameter op row.
        const opsA = listOperationsByTx(dbA, txA.id);
        const opsB = listOperationsByTx(dbB, txB.id);
        expect(opsA).toHaveLength(1);
        expect(opsA[0]!.kind).toBe("AddParameter");
        expect(opsB).toHaveLength(1);
        expect(opsB[0]!.kind).toBe("AddParameter");

        // Rendered src/ text maps must be byte-equal across all modules.
        const rendA = renderCommitted(dbA);
        const rendB = renderCommitted(dbB);
        expect(rendA.size).toBeGreaterThan(0);
        expect(rendB.size).toBe(rendA.size);
        for (const [key, textA] of rendA) {
          expect(rendB.get(key)).toBe(textA);
        }
      } finally {
        dbA.close();
        dbB.close();
      }
    }
  );
});
