/**
 * MODEL-FREE tool-output probe (no API key, deterministic).
 *
 * Purpose: answer "do the documented tools surface what the HD task needs?"
 * by driving the EXACT agent-facing handlers from createStrataTools over
 * the lab corpus and printing their full, untruncated results — the thing
 * the runner never showed and that the "agent won't act" claim skipped.
 *
 * The crux question, printed explicitly at the end: from the documented
 * output of `find_declarations`/`read_node`/`get_references`, can a caller
 * determine WHICH module/scope each `ZONE` constant belongs to? If not,
 * the per-scope mapping is not derivable from the documented tool surface
 * and the failure is tool legibility, NOT "the agent won't act".
 */
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

  const ctx: StrataSessionContext = { db, actor: "probe", acceptance: undefined };
  const tools = createStrataTools(ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const call = async (name: string, args: unknown): Promise<unknown> => {
    const def = byName.get(name);
    if (!def) throw new Error(`no tool ${name}`);
    const r = (await (def.handler as (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }>)(args, {}));
    const text = r.content?.[0]?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const show = (label: string, v: unknown): void => {
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(v, null, 2));
  };

  // Exactly the calls the agent made first, with FULL results.
  const fts = (await call("find_declarations", {
    name: "formatTimestamp",
    kind: "function"
  })) as { id: string }[];
  show('find_declarations {name:"formatTimestamp",kind:"function"}', fts);

  const zoneAny = (await call("find_declarations", { name: "ZONE" })) as {
    id: string;
  }[];
  show('find_declarations {name:"ZONE"}', zoneAny);

  show(
    'find_declarations {kind:"variable",name:"ZONE"}',
    await call("find_declarations", { kind: "variable", name: "ZONE" })
  );

  show(
    'find_declarations {name:"config"}',
    await call("find_declarations", { name: "config" })
  );

  if (fts[0]) {
    show(
      `get_references {declaration_id:"${fts[0].id}"} (formatTimestamp)`,
      await call("get_references", { declaration_id: fts[0].id })
    );
  }

  // For each ZONE hit, what does read_node (with children) reveal — and
  // does ANYTHING tie it to src/server vs src/ui?
  for (const z of Array.isArray(zoneAny) ? zoneAny : []) {
    show(
      `read_node {node_id:"${z.id}",include_children:true} (a ZONE)`,
      await call("read_node", { node_id: z.id, include_children: true })
    );
  }

  // The verdict the runner never computed.
  console.log("\n=== CRUX ===");
  console.log(
    `find_declarations {name:"ZONE"} returned ${
      Array.isArray(zoneAny) ? zoneAny.length : 0
    } node(s). Question: from these results + read_node, can a caller ` +
      `determine which ZONE is under src/server/ vs src/ui/ using ONLY ` +
      `documented tool output? Inspect the payloads above for any ` +
      `module/path/scope signal.`
  );
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
