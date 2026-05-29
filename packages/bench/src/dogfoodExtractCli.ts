import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EXTRACT_DOGFOOD_PROMPT,
  renderDogfoodExtractMarkdown,
  runDogfoodExtract
} from "./dogfoodExtract";

interface ParsedArgs {
  corpusRoot: string;
  prompt?: string;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
  outDir?: string;
  jsonOut?: string;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const positional: string[] = [];
  let prompt: string | undefined;
  let model: string | undefined;
  let maxTurns: number | undefined;
  let wallTimeMs: number | undefined;
  let outDir: string | undefined;
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--prompt") prompt = argv[++i];
    else if (arg === "--model") model = argv[++i];
    else if (arg === "--max-turns") {
      const next = argv[++i];
      maxTurns = next ? Number(next) : undefined;
    } else if (arg === "--wall-ms") {
      const next = argv[++i];
      wallTimeMs = next ? Number(next) : undefined;
    } else if (arg === "--out-dir") outDir = argv[++i];
    else if (arg === "--json-out") jsonOut = argv[++i];
    else if (arg.startsWith("--")) return null;
    else positional.push(arg);
  }
  if (positional.length !== 1) return null;
  return { corpusRoot: positional[0]!, prompt, model, maxTurns, wallTimeMs, outDir, jsonOut };
}

const USAGE =
  "Usage: pnpm --filter @strata/bench dogfood:extract -- <corpusRoot> " +
  "[--prompt <text>] [--model <id>] [--max-turns N] [--wall-ms N] [--out-dir <dir>] [--json-out <file>]\n" +
  "\n" +
  "  Paired dogfood for extract_function on <corpusRoot> (default examples/medium):\n" +
  "    1) baseline   (file-tools Claude Code on a temp tree)\n" +
  "    2) substrate  (Strata agent with extract_function)\n" +
  "  Same natural-language prompt for both; default extracts the parseArgs\n" +
  "  token-parsing loop in src/flags.ts. Prints a comparison table + quality\n" +
  "  floor + honest caveats. Requires ANTHROPIC_API_KEY.\n" +
  "\n" +
  `  Default prompt: "${EXTRACT_DOGFOOD_PROMPT}"\n`;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.stderr.write(
      "extract dogfood requires ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN).\n"
    );
    return 1;
  }

  const result = await runDogfoodExtract({
    corpusRoot: path.resolve(parsed.corpusRoot),
    prompt: parsed.prompt,
    model: parsed.model,
    maxTurns: parsed.maxTurns,
    wallTimeMs: parsed.wallTimeMs
  });

  const markdown = renderDogfoodExtractMarkdown(result);
  process.stdout.write(markdown);

  if (parsed.outDir) {
    mkdirSync(parsed.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const mdPath = path.join(parsed.outDir, `dogfood-extract-${stamp}.md`);
    const jsonPath = path.join(parsed.outDir, `dogfood-extract-${stamp}.json`);
    writeFileSync(mdPath, markdown);
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`\nWrote ${mdPath}\nWrote ${jsonPath}\n`);
  }
  if (parsed.jsonOut) {
    writeFileSync(parsed.jsonOut, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`Wrote ${parsed.jsonOut}\n`);
  }

  // Exit 0 when the comparison is conclusive (both arms quality-pass), else 2.
  // "baseline cheaper" is a valid finding, not a harness failure.
  return result.bothQualityPass ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`dogfood-extract failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  }
);
