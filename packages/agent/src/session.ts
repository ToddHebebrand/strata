import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  query,
  type Options,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import { ingestBatch } from "@strata-code/ingest";
import {
  begin,
  insertNodes,
  insertReferences,
  openDb,
  rollback,
  type Db,
  type TxHandle
} from "@strata-code/store";
import {
  emptyT03Criteria,
  evaluateT01Criteria,
  evaluateT03Criteria,
  evaluateT05Criteria,
  evaluateT08Criteria,
  validate,
  behavioralFixturesForTask,
  type AcceptanceContext,
  type T01Criteria,
  type T03Criteria,
  type T05Criteria,
  type T08Criteria
} from "@strata-code/verify";
import { SessionLog } from "./log";
import {
  classifySessionError,
  runHermeticSession,
  singlePrompt,
  type HermeticQuery,
  type HermeticTerminalReason
} from "./hermeticSession";
import { STRATA_SYSTEM_PROMPT } from "./prompt";
import {
  createStrataToolServer,
  createStrataTools,
  STRATA_QUALIFIED_TOOL_NAMES,
  STRATA_SERVER_NAME,
  type StrataSessionContext
} from "./tools";

export { classifySessionError, singlePrompt };

export interface CollectedSession {
  /** The SDKSystemMessage.init tools list, if an init message was seen. */
  initTools?: string[];
  initMcpServers?: { name: string; status: string }[];
  /** Every message, in order, for assertions/replay. */
  messages: SDKMessage[];
}

/**
 * Drive query() to completion, collecting messages and the init tool list.
 * The caller owns maxTurns and abortController bounds in options.
 */
export async function collectSession(params: {
  prompt: string;
  options: Options;
}): Promise<CollectedSession> {
  const collected: CollectedSession = { messages: [] };
  for await (const message of query({
    prompt: singlePrompt(params.prompt),
    options: params.options
  })) {
    collected.messages.push(message);
    if (message.type === "system" && message.subtype === "init") {
      collected.initTools = message.tools;
      collected.initMcpServers = message.mcp_servers;
    }
  }
  return collected;
}

export interface ReplayStep {
  tool: string;
  args: unknown;
}

export interface RunAgentT03Params {
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  /** Optional SDK-enforced per-query dollar limit. */
  maxBudgetUsd?: number;
  /** When set, drive handlers from this transcript instead of the model. */
  replayTranscript?: ReplayStep[];
  /** Optional JSON-lines log file path. */
  logPath?: string;
  /**
   * LAB-ONLY, additive. Absent ⇒ byte-identical canonical behavior.
   * Replace the in-process Strata tool server with a variant (same tool
   * NAMES only — net-new names would trip the hermetic guard and are out
   * of seam scope).
   */
  toolServerFactory?: (
    ctx: StrataSessionContext
  ) => ReturnType<typeof createStrataToolServer>;
  /** LAB-ONLY, additive. SDK loop-level gate passthrough. */
  canUseTool?: Options["canUseTool"];
}

export type TerminalReason = HermeticTerminalReason | "replay_complete";

export interface AgentT03Result {
  criteria: T03Criteria;
  terminalReason: TerminalReason;
  log: SessionLog;
  /** The captured tool-call sequence, replayable as a fixture. */
  transcript: ReplayStep[];
  /** Rendered committed src text scored by the criteria wrapper. */
  rendered?: Map<string, string>;
}

export type BenchTaskId = "T01" | "T03" | "T05" | "T08";

export type TaskCriteria =
  | T01Criteria
  | T03Criteria
  | T05Criteria
  | T08Criteria;

export interface AgentTaskResult {
  taskId: BenchTaskId;
  criteria: TaskCriteria;
  terminalReason: TerminalReason;
  log: SessionLog;
  transcript: ReplayStep[];
  rendered?: Map<string, string>;
}

export interface RunAgentTaskParams extends RunAgentT03Params {
  taskId: BenchTaskId;
  /** Byte-exact seed tests/dateRange.test.ts; required for T05 scoring. */
  seedTestText?: string;
}

// Passed to the SDK's `disallowedTools` ("removed from the model's context
// and cannot be used"). `tools: []` is documented to disable all built-ins,
// but SDK 0.2.118 still injects `LSP` (a language-server tool that can
// inspect real files) — which violates the CLAUDE.md invariant that the
// agent's world is the node graph, not files. Disallowing it explicitly is
// the SDK's documented hard-removal path, not a guard relaxation.
const BANNED_BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "LSP"
];

export const T03_PROMPT =
  "Rename the exported interface `User` (defined in `src/types/user.ts`) to " +
  "`Account` everywhere it is referenced as a type, including type-only " +
  "re-exports and JSDoc. Leave unrelated string literals with the value " +
  '`"User"` (such as audit log discriminators) untouched. The full test ' +
  "suite must pass.";

export const T01_PROMPT =
  "Add a `timezone: string` parameter to `formatTimestamp` (after the " +
  'existing `ts` parameter). It should default to `"UTC"`. Update every ' +
  "callsite to pass the appropriate timezone: callsites inside modules " +
  'under `src/server/` should pass `"UTC"`; callsites under `src/ui/` ' +
  'should pass `"local"`. All other callsites should be left to take the ' +
  "default. The tests in `tests/format.test.ts` must pass.";

export const T05_PROMPT =
  "The test `tests/dateRange.test.ts` is failing. Investigate, fix the " +
  "underlying bug, and make the test suite pass without weakening any " +
  "assertion. Do not modify the test file.";

export const T08_PROMPT =
  'Change the return type of `getRole` to `"admin" | "editor" | ' +
  '"viewer"`. Update the function body so the literal type is preserved ' +
  "(use `as const` or explicit annotation, not `as` casts that erase " +
  "information). Update every caller that benefits from the narrower type " +
  "- for example, replace any exhaustive `if (role === ...)` guards with " +
  "`switch` statements where appropriate, and remove any `as` casts that " +
  "are now redundant. The test suite must pass.";

export const TASK_PROMPTS: Record<BenchTaskId, string> = {
  T01: T01_PROMPT,
  T03: T03_PROMPT,
  T05: T05_PROMPT,
  T08: T08_PROMPT
};

function collectTsFiles(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (entry.endsWith(".ts")) {
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
      }
    }
  }

  walk(rootDir);
  return out;
}

/** Substitute the "$TX" placeholder in replay args with the live handle. */
function substituteTx(args: unknown, tx: TxHandle | undefined): unknown {
  if (args === "$TX") {
    if (!tx) {
      throw new Error("Replay transcript used $TX before begin_transaction");
    }
    return tx;
  }
  if (Array.isArray(args)) {
    return args.map((value) => substituteTx(value, tx));
  }
  if (isRecord(args)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      out[key] = substituteTx(value, tx);
    }
    return out;
  }
  return args;
}

interface ScoreInput {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  txId: string;
}

type ScoreFromCommitted<
  C extends {
    commitReturnedOk: boolean;
    validateAfterCommitClean: boolean;
    operationRowAppended: boolean;
  }
> = (
  db: Db,
  batch: ReturnType<typeof ingestBatch>,
  srcRoot: string,
  input: ScoreInput
) => C & { rendered?: Map<string, string> };

async function runAgentForPrompt<
  C extends {
    commitReturnedOk: boolean;
    validateAfterCommitClean: boolean;
    operationRowAppended: boolean;
  }
>(params: {
  runParams: RunAgentT03Params;
  taskLabel: string;
  acceptance: AcceptanceContext | undefined;
  actor: string;
  prompt: string;
  emptyCriteria: () => C;
  scoreFromCommitted: ScoreFromCommitted<C>;
}): Promise<{
  criteria: C;
  terminalReason: TerminalReason;
  log: SessionLog;
  transcript: ReplayStep[];
  rendered?: Map<string, string>;
}> {
  const { runParams } = params;
  const srcRoot = path.join(runParams.corpusRoot, "src");
  const batch = ingestBatch(collectTsFiles(srcRoot));
  const db = openDb(":memory:");
  const log = new SessionLog(runParams.logPath);
  const transcript: ReplayStep[] = [];
  let terminalReason: TerminalReason = "error_other";

  try {
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const ctx: StrataSessionContext = {
      db,
      actor: params.actor,
      acceptance: params.acceptance,
      taskPrompt: params.prompt
    };
    const tools = createStrataTools(ctx);
    const byName = new Map(tools.map((definition) => [definition.name, definition]));

    log.append({
      type: "session_start",
      ts: Date.now(),
      model: runParams.model,
      maxTurns: runParams.maxTurns,
      wallTimeMs: runParams.wallTimeMs,
      task: params.taskLabel,
      actor: ctx.actor
    });

    let liveTx: TxHandle | undefined;
    let lastCommitOk = false;

    const setLiveTx = (tx: TxHandle): void => {
      liveTx = tx;
    };
    const setLastCommitOk = (ok: boolean): void => {
      lastCommitOk = ok;
    };

    async function runStep(
      toolName: string,
      rawArgs: unknown,
      turn: number
    ): Promise<unknown> {
      const definition = byName.get(toolName);
      if (!definition) {
        throw new Error(`Unknown Strata tool: ${toolName}`);
      }

      const started = Date.now();
      const args = substituteTx(rawArgs, liveTx);
      let parsed: unknown = null;
      let ok = true;
      let error: string | null = null;

      try {
        const handler = definition.handler as (
          args: unknown,
          extra: unknown
        ) => Promise<{ content: { type: string; text?: string }[] }>;
        parsed = parseToolHandlerResult(await handler(args, {}));
      } catch (caught) {
        ok = false;
        error = caught instanceof Error ? caught.message : String(caught);
      }

      if (!ok) {
        throw new Error(error ?? `Tool ${toolName} failed`);
      }

      applyObservedToolResult(toolName, parsed, setLiveTx, setLastCommitOk);
      log.append({
        type: "tool_call",
        ts: Date.now(),
        tool: toolName,
        args: rawArgs,
        result_summary: log.summarizeResult(parsed),
        ok,
        error,
        durationMs: Date.now() - started,
        turn
      });
      transcript.push({ tool: toolName, args: rawArgs });
      return parsed;
    }

    if (runParams.replayTranscript) {
      let turn = 0;
      for (const step of runParams.replayTranscript) {
        await runStep(step.tool, step.args, turn++);
      }
      terminalReason = "replay_complete";
    } else {
      terminalReason = await runLiveSession({
        params: runParams,
        prompt: params.prompt,
        ctx,
        log,
        transcript,
        setLiveTx,
        setLastCommitOk
      });
    }

    const checkTx = begin(db, "agent-t03-check");
    const postCommitDiagnostics = validate(db, checkTx);
    rollback(db, checkTx);

    const scored = liveTx
      ? params.scoreFromCommitted(db, batch, srcRoot, {
          commitReturnedOk: lastCommitOk,
          validateAfterCommitClean: postCommitDiagnostics.length === 0,
          txId: liveTx.id
        })
      : params.emptyCriteria();

    const rendered =
      scored !== null &&
      typeof scored === "object" &&
      "rendered" in scored &&
      scored.rendered instanceof Map
        ? scored.rendered
        : undefined;

    return {
      criteria: scored as C,
      terminalReason,
      log,
      transcript,
      rendered
    };
  } finally {
    db.close();
  }
}

export async function runAgentT03(
  params: RunAgentT03Params
): Promise<AgentT03Result> {
  return runAgentForPrompt({
    runParams: params,
    taskLabel: "T03",
    acceptance: params.replayTranscript
      ? undefined
      : {
          corpusRoot: params.corpusRoot,
          srcRoot: path.join(params.corpusRoot, "src"),
          behavioralFixtures: behavioralFixturesForTask("T03")
        },
    actor: "agent-t03",
    prompt: T03_PROMPT,
    emptyCriteria: emptyT03Criteria,
    scoreFromCommitted: (db, batch, srcRoot, input) =>
      evaluateT03Criteria(db, batch, srcRoot, {
        commitReturnedOk: input.commitReturnedOk,
        validateAfterCommitClean: input.validateAfterCommitClean,
        renameTxId: input.txId
      })
  });
}

export async function runAgentTask(
  params: RunAgentTaskParams
): Promise<AgentTaskResult> {
  if (params.taskId === "T03") {
    const result = await runAgentT03(params);
    return { taskId: "T03", ...result };
  }

  const taskId = params.taskId as Exclude<BenchTaskId, "T03">;
  const prompt = TASK_PROMPTS[taskId];
  const actor = `agent-${taskId.toLowerCase()}`;
  const seedTestText =
    params.seedTestText ??
    (taskId === "T05"
      ? readFileSync(
          path.join(params.corpusRoot, "tests", "dateRange.test.ts"),
          "utf8"
        )
      : undefined);

  const result = await runAgentForPrompt({
    runParams: params,
    taskLabel: taskId,
    acceptance: params.replayTranscript
      ? undefined
      : {
          corpusRoot: params.corpusRoot,
          srcRoot: path.join(params.corpusRoot, "src"),
          behavioralFixtures: behavioralFixturesForTask(taskId)
        },
    actor,
    prompt,
    emptyCriteria: () => emptyTaskCriteria(taskId),
    scoreFromCommitted: (db, batch, srcRoot, input) => {
      if (taskId === "T01") {
        return evaluateT01Criteria(db, batch, srcRoot, {
          commitReturnedOk: input.commitReturnedOk,
          validateAfterCommitClean: input.validateAfterCommitClean,
          txId: input.txId
        });
      }
      if (taskId === "T05") {
        return evaluateT05Criteria(db, batch, srcRoot, {
          commitReturnedOk: input.commitReturnedOk,
          validateAfterCommitClean: input.validateAfterCommitClean,
          txId: input.txId,
          seedTestText: seedTestText ?? ""
        });
      }
      return evaluateT08Criteria(db, batch, srcRoot, {
        commitReturnedOk: input.commitReturnedOk,
        validateAfterCommitClean: input.validateAfterCommitClean,
        txId: input.txId
      });
    }
  });

  return { taskId, ...result };
}

function emptyTaskCriteria(taskId: Exclude<BenchTaskId, "T03">): TaskCriteria {
  if (taskId === "T01") {
    return {
      commitReturnedOk: false,
      validateAfterCommitClean: false,
      signatureHasTimezone: false,
      defaultIsUtcString: false,
      serverCallsitesUtc: false,
      uiCallsitesLocalOrDefault: false,
      hofCallsiteNotMisedited: false,
      operationRowAppended: false
    };
  }
  if (taskId === "T05") {
    return {
      commitReturnedOk: false,
      validateAfterCommitClean: false,
      comparisonIsHalfOpen: false,
      noClosedIntervalRemains: false,
      testFileByteIdentical: false,
      operationRowAppended: false
    };
  }
  return {
    commitReturnedOk: false,
    validateAfterCommitClean: false,
    returnTypeIsLiteralUnion: false,
    noAsStringCastOnResult: false,
    callersTypecheckUnderNarrowType: false,
    operationRowAppended: false
  };
}

/**
 * Load a recorded JSON-lines session log and extract the ordered tool-call
 * sequence as ReplayStep[]. Only tool_call events contribute; the
 * declaration_id captured at record time is reused for the fixed corpus, and
 * "$TX" placeholders are preserved so replay re-threads a fresh handle.
 */
export function loadTranscriptFixture(filePath: string): ReplayStep[] {
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const steps: ReplayStep[] = [];

  for (const line of lines) {
    const event = JSON.parse(line) as {
      type?: string;
      tool?: string;
      args?: unknown;
    };
    if (event.type === "tool_call" && event.tool) {
      steps.push({ tool: event.tool, args: event.args ?? {} });
    }
  }

  return steps;
}

/**
 * Normalize a captured transcript for fixture storage: replace any tx
 * argument that looks like a TxHandle ({ id, actor }) with the "$TX"
 * placeholder so the replay path re-threads a fresh live handle.
 */
export function normalizeTranscriptForFixture(
  steps: ReplayStep[]
): ReplayStep[] {
  function normalize(value: unknown): unknown {
    if (
      isRecord(value) &&
      typeof value.id === "string" &&
      typeof value.actor === "string" &&
      Object.keys(value).length === 2
    ) {
      return "$TX";
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item));
    }
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        out[key] = normalize(nested);
      }
      return out;
    }
    return value;
  }

  return steps.map((step) => ({
    tool: step.tool,
    args: normalize(step.args)
  }));
}

export interface LabCriteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  operationRowAppended: boolean;
  [extra: string]: boolean;
}

export interface AgentLabResult {
  criteria: LabCriteria;
  terminalReason: TerminalReason;
  log: SessionLog;
  transcript: ReplayStep[];
  rendered?: Map<string, string>;
}

export interface RunAgentLabParams extends RunAgentT03Params {
  actor: string;
  prompt: string;
  acceptance: AcceptanceContext | undefined;
  emptyCriteria: () => LabCriteria;
  score: ScoreFromCommitted<LabCriteria>;
}

export async function runAgentLab(
  params: RunAgentLabParams
): Promise<AgentLabResult> {
  const { actor, prompt, acceptance, emptyCriteria, score, ...runParams } =
    params;
  const out = await runAgentForPrompt<LabCriteria>({
    runParams,
    taskLabel: `lab:${actor}`,
    acceptance,
    actor,
    prompt,
    emptyCriteria,
    scoreFromCommitted: score
  });
  return {
    criteria: out.criteria,
    terminalReason: out.terminalReason,
    log: out.log,
    transcript: out.transcript,
    rendered: out.rendered
  };
}

export async function runLiveSession(deps: {
  params: RunAgentT03Params;
  prompt?: string;
  ctx: StrataSessionContext;
  log: SessionLog;
  transcript: ReplayStep[];
  setLiveTx: (tx: TxHandle) => void;
  setLastCommitOk: (ok: boolean) => void;
  queryFn?: HermeticQuery;
}): Promise<TerminalReason> {
  const { params, ctx, log, transcript } = deps;
  const server = (deps.params.toolServerFactory ?? createStrataToolServer)(ctx);
  const output = await runHermeticSession({
    prompt: deps.prompt ?? T03_PROMPT,
    systemPrompt: STRATA_SYSTEM_PROMPT,
    serverName: STRATA_SERVER_NAME,
    server,
    allowedTools: STRATA_QUALIFIED_TOOL_NAMES,
    bannedBuiltins: BANNED_BUILTINS,
    model: params.model,
    maxTurns: params.maxTurns,
    wallTimeMs: params.wallTimeMs,
    ...(params.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: params.maxBudgetUsd }),
    ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
    ...(deps.queryFn ? { queryFn: deps.queryFn } : {}),
    callbacks: {
      onInit: (message) => {
        log.append({
          type: "init",
          ts: Date.now(),
          tools: message.tools,
          mcpServers: message.mcp_servers
        });
      },
      onAssistantText: ({ text, turn }) => {
        log.append({
          type: "assistant_text",
          ts: Date.now(),
          turn,
          text: text.slice(0, 240)
        });
      },
      onToolUse: ({ tool, args }) => {
        transcript.push({ tool, args });
      },
      onToolResult: ({ tool, args, result, isError, durationMs, turn }) => {
        applyObservedToolResult(
          tool,
          result,
          deps.setLiveTx,
          deps.setLastCommitOk
        );
        log.append({
          type: "tool_call",
          ts: Date.now(),
          tool,
          args,
          result_summary: log.summarizeResult(result),
          ok: !isError,
          error: isError ? log.summarizeResult(result) : null,
          durationMs,
          turn
        });
      },
      onResult: (message) => {
        log.append({
          type: "result",
          ts: Date.now(),
          subtype: message.subtype,
          numTurns: message.num_turns,
          durationMs: message.duration_ms,
          durationApiMs: message.duration_api_ms,
          totalCostUsd: message.total_cost_usd,
          usage: {
            inputTokens: getUsageNumber(message.usage, "input_tokens"),
            outputTokens: getUsageNumber(message.usage, "output_tokens"),
            cacheReadInputTokens: getUsageNumber(
              message.usage,
              "cache_read_input_tokens"
            ),
            cacheCreationInputTokens: getUsageNumber(
              message.usage,
              "cache_creation_input_tokens"
            )
          },
          modelUsage: message.modelUsage,
          errors: "errors" in message ? message.errors : []
        });
      },
      onStderr: (data) => {
        log.append({
          type: "assistant_text",
          ts: Date.now(),
          turn: -1,
          text: `[stderr] ${data}`.slice(0, 240)
        });
      },
      onError: (caught) => {
        log.append({
          type: "assistant_text",
          ts: Date.now(),
          turn: -1,
          text: `[session error] ${
            caught instanceof Error ? caught.message : String(caught)
          }`.slice(0, 240)
        });
      }
    }
  });

  return output.terminalReason;
}

function parseToolHandlerResult(result: {
  content: { type: string; text?: string }[];
}): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) {
    return null;
  }
  return JSON.parse(block.text) as unknown;
}

function applyObservedToolResult(
  toolName: string,
  parsed: unknown,
  setLiveTx: (tx: TxHandle) => void,
  setLastCommitOk: (ok: boolean) => void
): void {
  if (toolName === "begin_transaction" && isTxHandle(parsed)) {
    setLiveTx(parsed);
  } else if (toolName === "commit_transaction") {
    setLastCommitOk(isRecord(parsed) && parsed.ok === true);
  }
}

function isTxHandle(value: unknown): value is TxHandle {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.actor === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getUsageNumber(usage: unknown, key: string): number {
  return isRecord(usage) && typeof usage[key] === "number"
    ? usage[key]
    : 0;
}
