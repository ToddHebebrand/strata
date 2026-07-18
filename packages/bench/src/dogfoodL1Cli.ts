import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderDogfoodMarkdown, runDogfoodL1 } from "./dogfoodL1";

interface ParsedArgs {
  corpusRoot: string;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
  outDir?: string;
  jsonOut?: string;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const positional: string[] = [];
  let model: string | undefined;
  let maxTurns: number | undefined;
  let wallTimeMs: number | undefined;
  let outDir: string | undefined;
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      continue;
    }
    if (arg === "--model") {
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
  if (positional.length !== 1) return null;
  return {
    corpusRoot: positional[0]!,
    model,
    maxTurns,
    wallTimeMs,
    outDir,
    jsonOut
  };
}

const USAGE =
  "Usage: pnpm --filter @strata-code/bench dogfood:l1 -- <corpusRoot> " +
  "[--model <id>] [--max-turns N] [--wall-ms N] [--out-dir <dir>] [--json-out <file>]\n" +
  "\n" +
  "  Runs the freeform agent twice on <corpusRoot> with the T05 prompt:\n" +
  "    1) index-off  (--no-index equivalent)\n" +
  "    2) index-on   (default)\n" +
  "  Prints a comparison table to stdout. Requires ANTHROPIC_API_KEY.\n";

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.stderr.write(
      "L1.4 dogfood requires ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN).\n"
    );
    return 1;
  }

  const result = await runDogfoodL1({
    corpusRoot: path.resolve(parsed.corpusRoot),
    model: parsed.model,
    maxTurns: parsed.maxTurns,
    wallTimeMs: parsed.wallTimeMs
  });

  const markdown = renderDogfoodMarkdown(result);
  process.stdout.write(markdown);

  if (parsed.outDir) {
    mkdirSync(parsed.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const mdPath = path.join(parsed.outDir, `dogfood-l1-${stamp}.md`);
    const jsonPath = path.join(parsed.outDir, `dogfood-l1-${stamp}.json`);
    writeFileSync(mdPath, markdown);
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`\nWrote ${mdPath}\nWrote ${jsonPath}\n`);
  }
  if (parsed.jsonOut) {
    writeFileSync(parsed.jsonOut, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`Wrote ${parsed.jsonOut}\n`);
  }

  return result.acceptance.costUsdOnIsAtMost80PctOfOff ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`dogfood-l1 failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  }
);
