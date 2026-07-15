import fs from "node:fs";

fs.writeFileSync(process.argv[2], `${process.pid}`);
setTimeout(() => process.exit(0), 10_000);
