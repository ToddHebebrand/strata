import { fail, type CommandResult } from "./format";
import { openOrIngest } from "./openOrIngest";
import { runExports } from "./exports";
import { runFind } from "./find";
import { runModules } from "./modules";
import { runRefs } from "./refs";
import { runSearch } from "./search";
import { runShow } from "./show";

export type { CommandResult } from "./format";

const EXPLORE_COMMANDS = new Set([
  "modules",
  "ls",
  "exports",
  "find",
  "show",
  "refs",
  "search"
]);

export function isExploreCommand(command: string): boolean {
  return EXPLORE_COMMANDS.has(command);
}

export const EXPLORE_USAGE = [
  "strata modules <source>                    list modules with ids (alias: ls)",
  "strata exports <source> <modulePath>       top-level declarations of one module",
  "strata find <source> <name> [--kind k]     find declarations by name (kind: interface|type-alias|class|function|variable)",
  "strata show <source> <nodeId>              inspect one node: source text + structure",
  "strata refs <source> <nodeId>              every resolved reference to a declaration",
  'strata search <source> "<query>" [-k N]    semantic search (needs embeddings)',
  "",
  "<source> is a corpus directory (ephemeral in-memory ingest) or a persisted .db.",
  "Every command supports --json. IDs printed by discovery commands (modules/",
  "exports/find) are the input to inspection commands (show/refs); for an",
  "unchanged corpus directory, ids are deterministic across invocations."
].join("\n");

interface ParsedExploreArgs {
  source: string;
  positional: string[];
  json: boolean;
  kind?: string;
  k: number;
}

function parseArgs(rest: string[]): ParsedExploreArgs | null {
  const positional: string[] = [];
  let json = false;
  let kind: string | undefined;
  let k = 8;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--kind") {
      kind = rest[++i];
    } else if (arg === "-k") {
      const next = rest[++i];
      k = next ? Number(next) : Number.NaN;
      if (!Number.isInteger(k) || k <= 0) return null;
    } else if (arg.startsWith("--")) {
      return null;
    } else {
      positional.push(arg);
    }
  }
  const [source, ...remaining] = positional;
  if (!source) return null;
  return { source, positional: remaining, json, kind, k };
}

const USAGE_BY_COMMAND: Record<string, string> = {
  modules: "Usage: strata modules <source> [--json]",
  ls: "Usage: strata ls <source> [--json]",
  exports: "Usage: strata exports <source> <modulePath> [--json]",
  find: "Usage: strata find <source> <name> [--kind k] [--json]",
  show: "Usage: strata show <source> <nodeId> [--json]",
  refs: "Usage: strata refs <source> <nodeId> [--json]",
  search: 'Usage: strata search <source> "<query>" [-k N] [--json]'
};

/**
 * Run one read-only exploration command. argv is [subcommand, ...rest].
 * Never mutates the store; ephemeral dbs are closed before returning.
 */
export async function runExplore(argv: string[]): Promise<CommandResult> {
  const [command, ...rest] = argv;
  if (!command || !isExploreCommand(command)) {
    return fail(`unknown explore command: ${command ?? "<none>"}`);
  }
  const usage = USAGE_BY_COMMAND[command]!;
  const parsed = parseArgs(rest);
  if (!parsed) return fail(usage);

  const expectedExtras =
    command === "modules" || command === "ls" ? 0 : 1;
  if (parsed.positional.length !== expectedExtras) return fail(usage);

  let opened;
  try {
    opened = openOrIngest(parsed.source);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const { db } = opened;
  try {
    switch (command) {
      case "modules":
      case "ls":
        return runModules(db, parsed.json);
      case "exports":
        return runExports(db, parsed.positional[0]!, parsed.json);
      case "find":
        return runFind(db, parsed.positional[0]!, parsed.kind, parsed.json);
      case "show":
        return runShow(db, parsed.positional[0]!, parsed.json);
      case "refs":
        return runRefs(db, parsed.positional[0]!, parsed.json);
      case "search":
        return await runSearch(db, parsed.positional[0]!, parsed.k, parsed.json);
      default:
        return fail(usage);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}
