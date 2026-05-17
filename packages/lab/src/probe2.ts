/** Root-cause probe: what does ingest actually produce for the config
 *  modules' `export const ZONE = "..."`? Model-free, free. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";

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

const batch = ingestBatch(collectTsFiles(SRC_ROOT));
const nodes = batch.allNodes as { id: string; kind: string; name?: string; payload?: unknown }[];

// Every node whose module path is a config.ts, or whose payload mentions ZONE.
const configish = nodes.filter((n) => {
  const p = typeof n.payload === "string" ? n.payload : JSON.stringify(n.payload ?? "");
  return p.includes("ZONE") || p.includes("config.ts") || /\bZONE\b/.test(n.name ?? "");
});
console.log(`total nodes: ${nodes.length}`);
console.log(`nodes mentioning ZONE / config.ts: ${configish.length}`);
for (const n of configish) {
  console.log(
    JSON.stringify({
      id: n.id,
      kind: n.kind,
      name: n.name,
      payload:
        typeof n.payload === "string"
          ? n.payload.slice(0, 160)
          : n.payload
    })
  );
}

// Distinct kinds present, and whether ANY 'variable'/const-ish kind exists.
const kinds = [...new Set(nodes.map((n) => n.kind))].sort();
console.log(`\ndistinct node kinds in corpus: ${kinds.join(", ")}`);

// The two config module nodes specifically.
const mods = nodes.filter(
  (n) =>
    typeof n.payload === "string" &&
    /(server|ui)\/config\.ts$/.test(n.payload as string)
);
console.log(`\nconfig module nodes: ${mods.length}`);
for (const m of mods) console.log(JSON.stringify({ id: m.id, kind: m.kind, payload: m.payload }));
