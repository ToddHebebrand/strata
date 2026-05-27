import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifySessionError, type TerminalReason } from "./session";

export const BASELINE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash"
] as const;

export interface MaterializeCorpusOptions {
  /**
   * Live baseline runs initialize a temporary git repository so Claude Code's
   * normal file tooling sees a repository-shaped workspace. Unit tests pass
   * false so this implementation session never runs git.
   */
  initGit?: boolean;
}

function repoRootFromHere(): string {
  return path.resolve(__dirname, "../../..");
}

/** Materialize a fresh recursive copy of the corpus in an OS temp dir. */
export function materializeCorpus(
  corpusRoot: string,
  options: MaterializeCorpusOptions = {}
): { root: string; srcRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "strata-baseline-"));
  const normalizedCorpusRoot = path.resolve(corpusRoot);

  cpSync(normalizedCorpusRoot, root, {
    recursive: true,
    filter: (src) => {
      const rel = path
        .relative(normalizedCorpusRoot, src)
        .replaceAll("\\", "/");
      if (rel === "") {
        return true;
      }
      const parts = rel.split("/");
      return !parts.includes("node_modules") && !parts.includes(".git");
    }
  });

  // Prefer the corpus's real dependencies; fall back to Strata's workspace
  // deps for small bench/example corpora that intentionally do not install.
  const corpusNodeModules = path.join(normalizedCorpusRoot, "node_modules");
  const repoNodeModules = path.join(repoRootFromHere(), "node_modules");
  const tmpNodeModules = path.join(root, "node_modules");
  if (existsSync(tmpNodeModules)) {
    rmSync(tmpNodeModules, { recursive: true, force: true });
  }
  if (existsSync(corpusNodeModules)) {
    symlinkSync(corpusNodeModules, tmpNodeModules, "dir");
  } else if (existsSync(repoNodeModules)) {
    symlinkSync(repoNodeModules, tmpNodeModules, "dir");
  }

  if (options.initGit !== false) {
    const init = spawnSync("git", ["init"], {
      cwd: root,
      encoding: "utf8"
    });
    if (init.status !== 0) {
      throw new Error(
        `git init failed in baseline temp tree: ${init.stderr || init.stdout}`
      );
    }
  }

  return { root, srcRoot: path.join(root, "src") };
}

export interface BaselineToolEvent {
  tool: string;
  path?: string;
  command?: string;
  exitCode?: number;
}

export interface BaselineResultCapture {
  subtype: string;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export interface BaselineSession {
  terminalReason: TerminalReason;
  result?: BaselineResultCapture;
  toolEvents: BaselineToolEvent[];
  toolInvocations: number;
  initTools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function usageNumber(usage: unknown, key: string): number {
  return isRecord(usage) && typeof usage[key] === "number"
    ? usage[key]
    : 0;
}

function terminalFromSubtype(subtype: string): TerminalReason {
  if (subtype === "success") {
    return "success";
  }
  if (subtype === "error_max_turns") {
    return "error_max_turns";
  }
  if (subtype === "error_during_execution") {
    return "error_during_execution";
  }
  return "error_other";
}

function parseExitCode(result: unknown): number | undefined {
  let text: string | undefined;
  if (isRecord(result)) {
    if (typeof result.content === "string") {
      text = result.content;
    } else if (Array.isArray(result.content)) {
      const block = result.content.find(
        (value): value is { type: string; text: string } =>
          isRecord(value) &&
          value.type === "text" &&
          typeof value.text === "string"
      );
      text = block?.text;
    }
  }
  if (text === undefined) {
    return undefined;
  }
  const match = /exit(?:\s*code)?[:=]?\s*(\d+)/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function collectToolResults(
  value: unknown,
  out: { id: string; result: unknown }[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolResults(item, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (value.type === "tool_result" && typeof value.tool_use_id === "string") {
    out.push({ id: value.tool_use_id, result: value });
    return;
  }

  for (const nested of Object.values(value)) {
    collectToolResults(nested, out);
  }
}

function inputPath(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (typeof input.file_path === "string") {
    return input.file_path;
  }
  if (typeof input.path === "string") {
    return input.path;
  }
  return undefined;
}

/**
 * Drive any async-iterable of SDK-shaped messages to completion, capturing
 * terminal SDKResult metrics and a flat tool-event list. Injectable by
 * design: key-free tests pass a synthetic generator; live runners pass the
 * real query(...) generator without changing this collector.
 */
export async function collectBaselineSession(
  stream: AsyncIterable<unknown>,
  signal?: { readonly aborted: boolean }
): Promise<BaselineSession> {
  const session: BaselineSession = {
    terminalReason: "error_other",
    toolEvents: [],
    toolInvocations: 0,
    initTools: []
  };
  const pending = new Map<string, { tool: string; input: unknown }>();

  try {
    for await (const message of stream) {
      if (!isRecord(message)) {
        continue;
      }

      if (message.type === "system" && message.subtype === "init") {
        session.initTools = Array.isArray(message.tools)
          ? message.tools.filter(
              (tool): tool is string => typeof tool === "string"
            )
          : [];
      } else if (message.type === "assistant") {
        const content =
          isRecord(message.message) && Array.isArray(message.message.content)
            ? message.message.content
            : [];
        for (const block of content) {
          if (
            isRecord(block) &&
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            pending.set(block.id, { tool: block.name, input: block.input });
          }
        }
      } else if (message.type === "user") {
        const results: { id: string; result: unknown }[] = [];
        collectToolResults(message.tool_use_result, results);
        if (isRecord(message.message)) {
          collectToolResults(message.message.content, results);
        }

        for (const observed of results) {
          const call = pending.get(observed.id);
          if (!call) {
            continue;
          }
          pending.delete(observed.id);
          const input = isRecord(call.input) ? call.input : {};
          const command =
            typeof input.command === "string" ? input.command : undefined;
          session.toolEvents.push({
            tool: call.tool,
            path: inputPath(input),
            command,
            exitCode:
              call.tool === "Bash" ? parseExitCode(observed.result) : undefined
          });
          session.toolInvocations++;
        }
      } else if (message.type === "result") {
        const subtype =
          typeof message.subtype === "string" ? message.subtype : "error";
        session.terminalReason = terminalFromSubtype(subtype);
        session.result = {
          subtype,
          numTurns:
            typeof message.num_turns === "number" ? message.num_turns : 0,
          durationMs:
            typeof message.duration_ms === "number" ? message.duration_ms : 0,
          durationApiMs:
            typeof message.duration_api_ms === "number"
              ? message.duration_api_ms
              : 0,
          totalCostUsd:
            typeof message.total_cost_usd === "number"
              ? message.total_cost_usd
              : 0,
          usage: {
            inputTokens: usageNumber(message.usage, "input_tokens"),
            outputTokens: usageNumber(message.usage, "output_tokens"),
            cacheReadInputTokens: usageNumber(
              message.usage,
              "cache_read_input_tokens"
            ),
            cacheCreationInputTokens: usageNumber(
              message.usage,
              "cache_creation_input_tokens"
            )
          }
        };
      }
    }
  } catch (caught) {
    const { terminal, rethrow } = classifySessionError(
      caught,
      signal?.aborted ?? false
    );
    if (rethrow) {
      throw caught;
    }
    session.terminalReason = terminal;
  }

  return session;
}

const BASELINE_MUTATING = new Set(["Edit", "Write"]);

function isFailedVerification(
  event: BaselineToolEvent,
  editedSoFar: Set<string>
): boolean {
  if (
    event.tool === "Bash" &&
    typeof event.command === "string" &&
    /\b(tsc|vitest|test)\b/.test(event.command) &&
    typeof event.exitCode === "number" &&
    event.exitCode !== 0
  ) {
    return true;
  }

  return (
    BASELINE_MUTATING.has(event.tool) &&
    typeof event.path === "string" &&
    editedSoFar.has(event.path)
  );
}

export function countBaselineRetries(events: BaselineToolEvent[]): number {
  let retries = 0;
  const editedSoFar = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (isFailedVerification(event, editedSoFar)) {
      const hasFollowingMutation = events
        .slice(i + 1)
        .some((next) => BASELINE_MUTATING.has(next.tool));
      if (hasFollowingMutation) {
        retries++;
      }
    }

    if (BASELINE_MUTATING.has(event.tool) && typeof event.path === "string") {
      editedSoFar.add(event.path);
    }
  }

  return retries;
}
