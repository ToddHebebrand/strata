import fs from "node:fs";

fs.writeFileSync(process.argv[2], "started");
