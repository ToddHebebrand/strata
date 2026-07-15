import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
for await (const _chunk of process.stdin) { /* drain */ }
setInterval(() => {}, 60_000);
