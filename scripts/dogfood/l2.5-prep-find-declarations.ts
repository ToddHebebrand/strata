import { openDb, find_declarations } from "@strata-code/store";

const dbPath = process.argv[2];
const name = process.argv[3] ?? "parse";
if (!dbPath) {
  console.error("Usage: tsx scripts/l2.5-prep-find-declarations.ts <db> [name]");
  process.exit(2);
}

const db = openDb(dbPath);
const hits = find_declarations(db, { name });
console.log(`find_declarations(${JSON.stringify(name)}) -> ${hits.length} hit(s)`);
for (const h of hits.slice(0, 10)) {
  console.log(JSON.stringify(h));
}
if (hits.length > 10) {
  console.log(`(+${hits.length - 10} more, truncated)`);
}
