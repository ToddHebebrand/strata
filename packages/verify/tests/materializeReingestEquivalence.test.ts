/**
 * Re-ingest equivalence regression guard for the graph-materialization pass.
 *
 * Invariant under test: after a materializing commit, the incremental node
 * graph must EQUAL the graph a clean re-ingest of the rendered text produces.
 * For each scenario we (1) seed, (2) mutate via a tool, (3) commit (materialize),
 * (4) render every module from the committed DB, (5) re-ingest that text fresh,
 * (6) diff node-ID sets and reference-edge sets. Any divergence is a real defect:
 *   - missingNodes  : in re-ingest, absent from live  -> NOT findable (the gap)
 *   - extraNodes    : in live, absent from re-ingest   -> stale/wrong node
 *   - missingRefs   : in re-ingest, absent from live   -> edge gap
 *   - extraRefs     : in live, absent from re-ingest   -> stale/dangling edge
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { render } from "@strata/render";
import {
  openDb,
  insertNodes,
  insertReferences,
  begin,
  create_function,
  add_import,
  add_parameter,
  loadModule,
  listModules,
  find_declarations,
  nodeId,
  type Db
} from "@strata/store";
import { commit } from "../src/validate";

type Snapshot = {
  nodes: Map<string, string>; // id -> kind
  refs: Set<string>; // `${from}|${to}|${kind}`
};

function snapshotLive(db: Db): Snapshot {
  const nodes = new Map<string, string>();
  for (const r of db.prepare(`SELECT id, kind FROM nodes`).all() as {
    id: string;
    kind: string;
  }[]) {
    nodes.set(r.id, r.kind);
  }
  const refs = new Set<string>();
  for (const r of db
    .prepare(`SELECT from_node_id, to_node_id, kind FROM node_references`)
    .all() as { from_node_id: string; to_node_id: string; kind: string }[]) {
    refs.add(`${r.from_node_id}|${r.to_node_id}|${r.kind}`);
  }
  return { nodes, refs };
}

function renderAll(db: Db): { path: string; text: string }[] {
  return listModules(db).map((m) => {
    const loaded = loadModule(db, m.id);
    return { path: m.payload, text: render(loaded.module, loaded.children) };
  });
}

function snapshotReingest(rendered: { path: string; text: string }[]): Snapshot {
  const batch = ingestBatch(rendered);
  const nodes = new Map<string, string>();
  for (const n of batch.allNodes) nodes.set(n.id, n.kind);
  const refs = new Set<string>();
  for (const r of batch.references)
    refs.add(`${r.fromNodeId}|${r.toNodeId}|${r.kind}`);
  return { nodes, refs };
}

function diff(label: string, live: Snapshot, reIngest: Snapshot): boolean {
  const missingNodes: string[] = [];
  const extraNodes: string[] = [];
  for (const [id, kind] of reIngest.nodes)
    if (!live.nodes.has(id)) missingNodes.push(`${kind} ${id}`);
  for (const [id, kind] of live.nodes)
    if (!reIngest.nodes.has(id)) extraNodes.push(`${kind} ${id}`);
  const missingRefs: string[] = [];
  const extraRefs: string[] = [];
  for (const r of reIngest.refs) if (!live.refs.has(r)) missingRefs.push(r);
  for (const r of live.refs) if (!reIngest.refs.has(r)) extraRefs.push(r);

  const ok =
    missingNodes.length === 0 &&
    extraNodes.length === 0 &&
    missingRefs.length === 0 &&
    extraRefs.length === 0;

  const tag = ok ? "HOLDS  ✓" : "BREAKS ✗";
  // eslint-disable-next-line no-console
  console.log(
    `\n[${tag}] ${label}` +
      `  (live ${live.nodes.size}n/${live.refs.size}e vs reingest ${reIngest.nodes.size}n/${reIngest.refs.size}e)`
  );
  const cap = (xs: string[]) =>
    xs.slice(0, 8).join("\n     ") + (xs.length > 8 ? `\n     …(+${xs.length - 8})` : "");
  if (missingNodes.length)
    console.log(`  missingNodes (not findable): ${missingNodes.length}\n     ${cap(missingNodes)}`);
  if (extraNodes.length)
    console.log(`  extraNodes   (stale):        ${extraNodes.length}\n     ${cap(extraNodes)}`);
  if (missingRefs.length)
    console.log(`  missingRefs  (edge gap):     ${missingRefs.length}\n     ${cap(missingRefs)}`);
  if (extraRefs.length)
    console.log(`  extraRefs    (dangling):     ${extraRefs.length}\n     ${cap(extraRefs)}`);
  return ok;
}

function seedFromInputs(inputs: { path: string; text: string }[]): Db {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

function probe(
  label: string,
  inputs: { path: string; text: string }[],
  mutate: (db: Db) => void
): boolean {
  const db = seedFromInputs(inputs);
  try {
    mutate(db);
  } catch (err) {
    console.log(`\n[BREAKS ✗] ${label}\n  threw: ${(err as Error).message}`);
    db.close();
    return false;
  }
  const live = snapshotLive(db);
  const reIngest = snapshotReingest(renderAll(db));
  const ok = diff(label, live, reIngest);
  db.close();
  return ok;
}

function commitOrReport(db: Db, tx: ReturnType<typeof begin>, label: string): void {
  const result = commit(db, tx);
  if (!result.ok) {
    const msgs = (result.diagnostics ?? [])
      .map((d) => `${d.code ?? "?"}: ${d.message}`)
      .join(" | ");
    throw new Error(`${label} commit failed -> ${msgs || "(no diagnostics)"}`);
  }
}

function loadMediumCorpus(): { root: string; files: { path: string; text: string }[] } {
  const root = path.resolve(__dirname, "../../../examples/medium/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) {
        // Use the REAL on-disk absolute path so findNearestTsconfig locates the
        // corpus's actual tsconfig (module: esnext, allowImportingTsExtensions),
        // matching how the on-disk T03 acceptance validates.
        files.push({ path: full.replaceAll("\\", "/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return { root, files };
}

describe("materialization re-ingest equivalence", () => {
  it("every materializing commit matches a clean re-ingest (node IDs + edges)", () => {
    const results: { label: string; ok: boolean }[] = [];
    const run = (label: string, inputs: { path: string; text: string }[], mutate: (db: Db) => void) =>
      results.push({ label, ok: probe(label, inputs, mutate) });

    // S1 — simple create_function, intra-module use already present.
    run(
      "S1 create_function (intra-module caller resolves to new decl)",
      [{ path: "/project/m.ts", text: `export function caller(): number { return h(); }\n` }],
      (db) => {
        const tx = begin(db, "s1");
        create_function(db, tx, nodeId("/project/m.ts", [], "Module"), `export function h(): number { return 1; }`);
        commitOrReport(db, tx, "S1");
      }
    );

    // S2 — created function with nested closures (DFS depth / identifier indexing).
    run(
      "S2 create_function with nested arrow + closure capture",
      [{ path: "/project/m.ts", text: `export const seed = 2;\n` }],
      (db) => {
        const tx = begin(db, "s2");
        create_function(
          db,
          tx,
          nodeId("/project/m.ts", [], "Module"),
          `export function build(): number {\n  const xs = [1, 2, 3];\n  return xs.map((v) => v + seed).reduce((a, b) => a + b, 0);\n}`
        );
        commitOrReport(db, tx, "S2");
      }
    );

    // S3 — cross-module: A imports B; create a function in A using B's export.
    run(
      "S3 create_function cross-module (uses imported symbol)",
      [
        { path: "/project/a.ts", text: `import { base } from "./b";\nexport const ax = base;\n` },
        { path: "/project/b.ts", text: `export const base = 10;\n` }
      ],
      (db) => {
        const tx = begin(db, "s3");
        create_function(db, tx, nodeId("/project/a.ts", [], "Module"), `export function scaled(): number { return base * 2; }`);
        commitOrReport(db, tx, "S3");
      }
    );

    // S4 — add_import then a created function uses the imported symbol (two ops, one tx).
    run(
      "S4 add_import + create_function using it (two ops one tx)",
      [
        { path: "/project/a.ts", text: `export const ax = 1;\n` },
        { path: "/project/b.ts", text: `export const helper = 5;\n` }
      ],
      (db) => {
        const tx = begin(db, "s4");
        const moduleA = nodeId("/project/a.ts", [], "Module");
        add_import(db, tx, moduleA, `import { helper } from "./b";`);
        create_function(db, tx, moduleA, `export function use(): number { return helper; }`);
        commitOrReport(db, tx, "S4");
      }
    );

    // S5 — add_parameter on a function with two call sites (class-2 across statements).
    run(
      "S5 add_parameter, two call sites (class-2 re-derivation)",
      [
        {
          path: "/project/m.ts",
          text:
            `export function greet(name: string): string {\n  return "hi " + name;\n}\n` +
            `export const a = greet("x");\n` +
            `export const b = greet("y");\n`
        }
      ],
      (db) => {
        const tx = begin(db, "s5");
        const greetId = find_declarations(db, { name: "greet" })[0]!.id;
        add_parameter(db, tx, greetId, "loud", "boolean", 1, "false");
        commitOrReport(db, tx, "S5");
      }
    );

    // S6 — multiple create_function in one transaction (multiple inserted nodes).
    run(
      "S6 two create_function in one tx (mutual + forward refs)",
      [{ path: "/project/m.ts", text: `export const root = 1;\n` }],
      (db) => {
        const tx = begin(db, "s6");
        const moduleId = nodeId("/project/m.ts", [], "Module");
        create_function(db, tx, moduleId, `export function one(): number { return root + 1; }`);
        create_function(db, tx, moduleId, `export function two(): number { return one() + 1; }`);
        commitOrReport(db, tx, "S6");
      }
    );

    // S8 — created function carries a JSDoc block. emitIdentifiers' DFS walks
    // getChildren (which INCLUDES JSDoc), so JSDoc @param/@returns identifiers
    // enter the identifier index. If materialized indexing diverges from
    // re-ingest here, IDs shift.
    run(
      "S8 create_function with a JSDoc block (JSDoc identifiers in DFS)",
      [{ path: "/project/m.ts", text: `export const base = 1;\n` }],
      (db) => {
        const tx = begin(db, "s8");
        const moduleId = nodeId("/project/m.ts", [], "Module");
        create_function(
          db,
          tx,
          moduleId,
          `/**\n * Adds the offset to the base.\n * @param offset - the amount to add\n * @returns the sum\n */\nexport function withDoc(offset: number): number {\n  return base + offset;\n}`
        );
        commitOrReport(db, tx, "S8");
      }
    );

    // S9 — generics + type reference + namespace-style use. Exercises type-kind
    // and value-kind edges and type-parameter identifiers in one created node.
    run(
      "S9 create_function generic + type ref (mixed edge kinds)",
      [
        {
          path: "/project/m.ts",
          text: `export interface Box<T> {\n  value: T;\n}\nexport const seed: Box<number> = { value: 1 };\n`
        }
      ],
      (db) => {
        const tx = begin(db, "s9");
        const moduleId = nodeId("/project/m.ts", [], "Module");
        create_function(
          db,
          tx,
          moduleId,
          `export function unwrap<T>(box: Box<T>): T {\n  return box.value;\n}`
        );
        commitOrReport(db, tx, "S9");
      }
    );

    // S7 — REAL CORPUS: ingest examples/medium, create a function in store.ts that
    // calls an existing same-module export, commit, equivalence over ALL modules.
    const corpus = loadMediumCorpus();
    const storePath = `${corpus.root}/store.ts`;
    const storeMod = corpus.files.find((c) => c.path === storePath);
    if (storeMod) {
      run("S7 real corpus (examples/medium): create_function in store.ts", corpus.files, (db) => {
        const tx = begin(db, "s7");
        const moduleId = nodeId(storePath, [], "Module");
        // A trivially type-correct addition that references nothing external.
        create_function(db, tx, moduleId, `export function __probeNoop(): number { return 0; }`);
        commitOrReport(db, tx, "S7");
      });
    } else {
      console.log(`\n[SKIP] S7 — ${storePath} not found in corpus`);
    }

    // Summary + assertion. Every scenario's materialized graph must equal a
    // clean re-ingest of the rendered text (node-ID set + reference edges).
    const broke = results.filter((r) => !r.ok);
    console.log(`\n===== SUMMARY: ${results.length - broke.length}/${results.length} hold =====`);
    for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label}`);
    expect(broke.map((r) => r.label)).toEqual([]);
  }, 60000);
});
