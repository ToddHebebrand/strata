import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderDogfoodL3Markdown, runDogfoodL3 } from "./dogfoodL3";

interface ParsedArgs {
  corpusRoot: string;
  dbPath: string;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
  outDir?: string;
  jsonOut?: string;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const positional: string[] = [];
  let dbPath: string | undefined;
  let model: string | undefined;
  let maxTurns: number | undefined;
  let wallTimeMs: number | undefined;
  let outDir: string | undefined;
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--db") {
      dbPath = argv[++i];
    } else if (arg === "--model") {
      model = argv[++i];
    } else if (arg === "--max-turns") {
      const next = argv[++i];
      maxTurns = next ? Number(next) : undefined;
    } else if (arg === "--wall-ms") {
      const next = argv[++i];
      wallTimeMs = next ? Number(next) : undefined;
    } else if (arg === "--out-dir") {
      outDir = argv[++i];
    } else if (arg === "--json-out") {
      jsonOut = argv[++i];
    } else if (arg.startsWith("--")) {
      return null;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1 || !dbPath) return null;
  return {
    corpusRoot: positional[0]!,
    dbPath,
    model,
    maxTurns,
    wallTimeMs,
    outDir,
    jsonOut
  };
}

const USAGE =
  "Usage: node packages/bench/dist/dogfoodL3Cli.js <corpusRoot> --db <dbPath> " +
  "[--model <id>] [--max-turns N] [--wall-ms N] [--out-dir <dir>] [--json-out <file>]\n" +
  "\n" +
  "  Runs the agent twice on <corpusRoot> with a persistent --db:\n" +
  "    Arm A: rename User → Account (cold DB; --reset deletes the db first)\n" +
  "    Arm B: rename Clock → TimeSource (same DB; should see L3 retrieval)\n" +
  "  Requires ANTHROPIC_API_KEY for the agent and STRATA_EMBED_API_KEY for L3.\n";

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.stderr.write(
      "L3.4 dogfood requires ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN).\n"
    );
    return 1;
  }
  if (!process.env.STRATA_EMBED_API_KEY) {
    process.stderr.write(
      "L3.4 dogfood requires STRATA_EMBED_API_KEY (OpenAI) for commit-pattern embedding.\n" +
        "Without it, L3 silently disables and the comparison would be meaningless.\n"
    );
    return 1;
  }

  const result = await runDogfoodL3({
    corpusRoot: path.resolve(parsed.corpusRoot),
    dbPath: path.resolve(parsed.dbPath),
    model: parsed.model,
    maxTurns: parsed.maxTurns,
    wallTimeMs: parsed.wallTimeMs
  });

  const markdown = renderDogfoodL3Markdown(result);
  process.stdout.write(markdown);

  if (parsed.outDir) {
    mkdirSync(parsed.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const mdPath = path.join(parsed.outDir, `dogfood-l3-${stamp}.md`);
    const jsonPath = path.join(parsed.outDir, `dogfood-l3-${stamp}.json`);
    writeFileSync(mdPath, markdown);
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`\nWrote ${mdPath}\nWrote ${jsonPath}\n`);
  }
  if (parsed.jsonOut) {
    writeFileSync(parsed.jsonOut, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`Wrote ${parsed.jsonOut}\n`);
  }

  const allPass =
    result.acceptance.bothCommitsOk &&
    result.acceptance.commitPatternEmbeddedInA &&
    result.acceptance.pastTasksInjectedInB &&
    result.acceptance.bCostBelowA;
  return allPass ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`dogfood-l3 failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  }
);
