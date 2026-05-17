// Process entry point. Wires `process.argv` to the CLI runner and
// exits with the appropriate status code. Kept separate from `cli.ts`
// so the CLI logic is unit-testable without touching `process`.

import { runCli } from "./cli.ts";
import { KvStore } from "./store.ts";

async function main(): Promise<void> {
  const store = new KvStore<string>({ maxEntries: 4096 });
  const code = await runCli({
    argv: process.argv.slice(2),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    store,
  });
  process.exit(code);
}

// `import.meta.url` lets us check whether this module is being run directly.
// When imported (e.g. by tests), we don't auto-run.
const isDirectRun = process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  await main();
}
