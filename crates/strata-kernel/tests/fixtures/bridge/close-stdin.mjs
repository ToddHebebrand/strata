import fs from "node:fs";

fs.writeFileSync(process.argv[2], `${process.pid}`);
fs.closeSync(0);
setTimeout(() => process.exit(0), 10_000);
