/** Satisfiability probe (model-free, free): can an agent attribute a node
 *  to its module/scope using ONLY documented tools? Without that, the
 *  per-scope task is unsatisfiable no matter what declaration kind the
 *  per-scope signal uses. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { openDb, insertNodes, insertReferences } from "@strata/store";
import { createStrataTools, type StrataSessionContext } from "@strata/agent";

const SRC_ROOT = path.join(__dirname, "..", "corpus", "src");
function collectTsFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
    else if (p.endsWith(".ts")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

async function main(): Promise<void> {
  const batch = ingestBatch(collectTsFiles(SRC_ROOT));
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  const ctx: StrataSessionContext = { db, actor: "p3", acceptance: undefined };
  const byName = new Map(createStrataTools(ctx).map((t) => [t.name, t]));
  const call = async (n: string, a: unknown): Promise<any> => {
    const r = await (byName.get(n)!.handler as any)(a, {});
    try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
  };

  const fts = await call("find_declarations", { name: "formatTimestamp", kind: "function" });
  const refs = await call("get_references", { declaration_id: fts[0].id });
  console.log(`formatTimestamp has ${refs.length} reference edges (callsites).`);

  // For the FIRST callsite ref, exhaust documented inspection: can we learn
  // which module (src/server vs src/ui vs other) it lives in?
  const cs = refs[0];
  console.log(`\n-- callsite fromNodeId=${cs.fromNodeId} --`);
  console.log("read_node (no children):");
  console.log(JSON.stringify(await call("read_node", { node_id: cs.fromNodeId }), null, 2));
  console.log("read_node (children):");
  console.log(JSON.stringify(await call("read_node", { node_id: cs.fromNodeId, include_children: true }), null, 2));

  // Does read_node expose a parent / module / path field anywhere?
  const sample = await call("read_node", { node_id: cs.fromNodeId, include_children: true });
  const keys = sample && typeof sample === "object" ? Object.keys(sample) : [];
  console.log(`\nread_node result keys: ${keys.join(", ") || "(scalar/none)"}`);

  // Can the agent even enumerate modules? (find_declarations has no Module
  // kind; is there ANY documented call that lists modules/paths?)
  console.log(`\nfind_declarations kinds schema accepts: interface|type-alias|class|function|variable`);
  console.log(`Module nodes exist in store but find_declarations({kind:'module'}) is not allowed by schema.`);

  // VERDICT
  const text = JSON.stringify(sample);
  const hasPath = /src\/(server|ui|lib)\//.test(text) || /config\.ts|events\.ts|timeline\.ts/.test(text);
  console.log(
    `\n=== VERDICT ===\nDoes documented read_node output for a callsite reveal its module/scope? ${
      hasPath ? "YES (path/module signal present)" : "NO (no module/path/scope signal in documented output)"
    }`
  );
}
main().catch((e) => { console.error("probe3 crashed:", e); process.exit(1); });
