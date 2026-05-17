// A tiny CLI front-end to the kvstore. Not the focus of the example —
// it exists so the store has a non-trivial caller that exercises imports
// across the package.
//
// Commands:
//   put <key> <value> [--ttl <ms>] [--tag <name>]
//   get <key>
//   delete <key>
//   list
//   stats
//   save <path>
//   load <path>

import { FlagParseError, type ParsedArgs, numberOption, parseArgs } from "./flags.ts";
import { loadFromFile, saveToFile } from "./persistence.ts";
import { KvStore } from "./store.ts";

export interface CliEnv {
  argv: readonly string[];
  out: (line: string) => void;
  err: (line: string) => void;
  store: KvStore<string>;
}

const HELP = `usage: kvstore <command> [...args]

commands:
  put <key> <value> [--ttl <ms>] [--tag <name>]
  get <key>
  delete <key>
  list
  stats
  save <path>
  load <path>
  help
`;

export async function runCli(env: CliEnv): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(env.argv);
  } catch (err) {
    env.err(err instanceof Error ? err.message : String(err));
    env.err(HELP);
    return 2;
  }

  try {
    switch (args.command) {
      case "help":
      case "--help":
      case "-h":
        env.out(HELP);
        return 0;
      case "put":
        return handlePut(env, args);
      case "get":
        return handleGet(env, args);
      case "delete":
        return handleDelete(env, args);
      case "list":
        return handleList(env);
      case "stats":
        return handleStats(env);
      case "save":
        return await handleSave(env, args);
      case "load":
        return await handleLoad(env, args);
      default:
        env.err(`unknown command: ${args.command}`);
        env.err(HELP);
        return 2;
    }
  } catch (err) {
    if (err instanceof FlagParseError) {
      env.err(err.message);
      return 2;
    }
    env.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function handlePut(env: CliEnv, args: ParsedArgs): number {
  const [key, value] = args.positional;
  if (!key || value === undefined) {
    env.err("put requires <key> and <value>");
    return 2;
  }
  const ttl = numberOption(args, "ttl", 0);
  const tagOpt = args.options["tag"];
  const tags = typeof tagOpt === "string" ? [tagOpt] : undefined;

  env.store.put(key, value, {
    ttlMs: ttl > 0 ? ttl : undefined,
    tags,
  });
  env.out(`ok`);
  return 0;
}

function handleGet(env: CliEnv, args: ParsedArgs): number {
  const [key] = args.positional;
  if (!key) {
    env.err("get requires <key>");
    return 2;
  }
  const value = env.store.get(key);
  if (value === undefined) {
    env.err(`miss: ${key}`);
    return 1;
  }
  env.out(value);
  return 0;
}

function handleDelete(env: CliEnv, args: ParsedArgs): number {
  const [key] = args.positional;
  if (!key) {
    env.err("delete requires <key>");
    return 2;
  }
  env.out(env.store.delete(key) ? `deleted ${key}` : `no such key: ${key}`);
  return 0;
}

function handleList(env: CliEnv): number {
  for (const entry of env.store.entriesOldestFirst()) {
    const ttl = entry.expiresAt === null ? "-" : `${entry.expiresAt}`;
    env.out(`${entry.key}\t${entry.value}\texpires=${ttl}\thits=${entry.hits}`);
  }
  return 0;
}

function handleStats(env: CliEnv): number {
  const stats = env.store.getStats();
  for (const [k, v] of Object.entries(stats)) {
    env.out(`${k}=${v}`);
  }
  return 0;
}

async function handleSave(env: CliEnv, args: ParsedArgs): Promise<number> {
  const [path] = args.positional;
  if (!path) {
    env.err("save requires <path>");
    return 2;
  }
  await saveToFile(env.store, path);
  env.out(`saved to ${path}`);
  return 0;
}

async function handleLoad(env: CliEnv, args: ParsedArgs): Promise<number> {
  const [path] = args.positional;
  if (!path) {
    env.err("load requires <path>");
    return 2;
  }
  await loadFromFile(env.store, path);
  env.out(`loaded from ${path}`);
  return 0;
}
