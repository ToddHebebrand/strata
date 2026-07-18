import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import { behavioralFixturesForTask } from "@strata-code/verify";
import {
  embedDeclarations,
  insertNodes,
  insertReferences,
  isVecAvailable,
  listModules,
  list_module_exports,
  OpenAIEmbeddingProvider,
  openDb,
  retrieveSimilarPastTasks,
  type EmbeddingProvider,
  type PastTaskHit,
  type TxHandle
} from "@strata-code/store";
import { SessionLog } from "./log";
import { buildModuleIndex } from "./moduleIndex";
import {
  runLiveSession,
  type ReplayStep,
  type TerminalReason
} from "./session";
import { type StrataSessionContext } from "./tools";

export interface RunAgentParams {
  /** Directory containing a `src/` tree of .ts files. */
  corpusRoot: string;
  /** Plain-English task description for the agent. */
  prompt: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  /**
   * Disk path for the SQLite store. When given, the operation log and node
   * graph persist across runs (re-invoke against the same path to continue
   * from where the previous session left off). When omitted, the store is
   * `:memory:` and dies with the process.
   */
  dbPath?: string;
  /** If true, delete an existing dbPath before opening and re-ingest fresh. */
  reset?: boolean;
  /**
   * Optional list of test fixture paths (relative to corpusRoot) the
   * commit gate must pass in addition to tsc. Empty/omitted ⇒ tsc-only gate,
   * the design's default.
   */
  behavioralFixtures?: readonly string[];
  /** Optional JSON-lines transcript log path. */
  logPath?: string;
  /** Actor name recorded on transactions and operations. Default: "agent". */
  actor?: string;
  /**
   * When true (default), prepend a "## Codebase shape" section built from the
   * store to the agent's task prompt. Lands in the first user turn so the
   * agent has an upfront map of modules and top-level declarations and skips
   * speculative `find_declarations` fishing. Disable via the CLI's
   * `--no-index` flag for paired with/without measurement.
   */
  injectModuleIndex?: boolean;
  /**
   * Layer 2 escape hatch for tests: inject an embedding provider directly,
   * bypassing the STRATA_EMBED_API_KEY/OpenAI default. Production runs leave
   * this undefined and rely on the env var.
   */
  embeddingProvider?: EmbeddingProvider;
}

export interface AgentResult {
  terminalReason: TerminalReason;
  log: SessionLog;
  transcript: ReplayStep[];
  /** Path of the persisted store, or undefined if the run was in-memory. */
  dbPath?: string;
  /** Operations appended to the log during this session. */
  newOperationsCount: number;
  /** Whether the agent's last commit_transaction returned ok. */
  lastCommitOk: boolean;
  /** Total operations in the log after this session (cumulative). */
  totalOperationsCount: number;
}

export interface AssembleAgentPromptInput {
  /** Pre-rendered L1 "## Codebase shape\n\n…" section, or null if disabled. */
  codebaseShapeSection: string | null;
  /** Pre-rendered L3 "## Past tasks like this one\n\n…" section, or null. */
  pastTasksSection: string | null;
  /** The original user task prompt. */
  userPrompt: string;
}

/**
 * Assemble the agent's first-turn prompt from optional L1/L3 sections plus the
 * user task. Ordering is the seam tested in tests/assembleAgentPrompt.test.ts:
 * codebase-shape first, then past-tasks, then a `---` separator, then the
 * original prompt. When neither section is present, the user prompt passes
 * through unchanged.
 */
export function assembleAgentPrompt(input: AssembleAgentPromptInput): string {
  const sections: string[] = [];
  if (input.codebaseShapeSection) sections.push(input.codebaseShapeSection);
  if (input.pastTasksSection) sections.push(input.pastTasksSection);
  if (sections.length === 0) return input.userPrompt;
  return `${sections.join("\n\n")}\n\n---\n\n${input.userPrompt}`;
}

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

export async function runAgent(params: RunAgentParams): Promise<AgentResult> {
  const srcRoot = path.join(params.corpusRoot, "src");
  if (!existsSync(srcRoot)) {
    throw new Error(
      `runAgent: ${srcRoot} does not exist. Expected a "src/" directory under corpusRoot.`
    );
  }

  if (params.dbPath && params.reset && existsSync(params.dbPath)) {
    unlinkSync(params.dbPath);
  }

  const db = openDb(params.dbPath ?? ":memory:");
  const existingNodeCount = (
    db.prepare("SELECT count(*) AS c FROM nodes").get() as { c: number }
  ).c;
  if (existingNodeCount === 0) {
    const batch = ingestBatch(collectTsFiles(srcRoot));
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
  }
  const operationsBefore = (
    db.prepare("SELECT count(*) AS c FROM operations").get() as { c: number }
  ).c;

  const actor = params.actor ?? "agent";
  const ctx: StrataSessionContext = {
    db,
    actor,
    // Layer 3: record the ORIGINAL prompt on every transaction opened in this
    // session, not the L1/L2-scaffolded one. Each commit pattern's
    // `triggering_prompt` should reflect what the user asked, not the auto-
    // injected codebase shape that varies per corpus.
    taskPrompt: params.prompt,
    acceptance: {
      corpusRoot: params.corpusRoot,
      srcRoot,
      behavioralFixtures: params.behavioralFixtures ?? [],
      // Freeform agent default: respect the project's own tsconfig scope.
      // The bench's src-only invariant is bench-isolation discipline that
      // doesn't apply to real projects, which routinely include test files
      // in their tsconfig include list (decisions.md 2026-05-26 dogfood
      // finding on unjs/defu).
      strictSrcOnlyTscScope: false
    }
  };

  const log = new SessionLog(params.logPath);
  ctx.log = log;

  // Layer 2: resolve an embedding provider. Test seam (params.embeddingProvider)
  // wins; otherwise instantiate the OpenAI default iff STRATA_EMBED_API_KEY is
  // set. When neither path produces a provider, Layer 2 stays silent and the
  // semantic_search tool returns an "unavailable" error to the agent.
  let embeddingProvider: EmbeddingProvider | undefined =
    params.embeddingProvider;
  if (!embeddingProvider && process.env.STRATA_EMBED_API_KEY) {
    try {
      embeddingProvider = new OpenAIEmbeddingProvider();
    } catch {
      embeddingProvider = undefined;
    }
  }

  if (embeddingProvider && isVecAvailable(db)) {
    const declIds: string[] = [];
    for (const mod of listModules(db)) {
      for (const exp of list_module_exports(db, mod.id)) {
        declIds.push(exp.id);
      }
    }
    if (declIds.length > 0) {
      try {
        const { embedded, skipped } = await embedDeclarations(
          db,
          declIds,
          embeddingProvider
        );
        log.append({
          type: "embeddings_built",
          ts: Date.now(),
          embedded,
          skipped,
          model: embeddingProvider.model
        });
      } catch (err) {
        log.append({
          type: "embeddings_failed",
          ts: Date.now(),
          reason: err instanceof Error ? err.message : String(err),
          model: embeddingProvider.model
        });
        embeddingProvider = undefined;
      }
    }
    if (embeddingProvider) {
      ctx.embeddingProvider = embeddingProvider;
    }
  }

  const transcript: ReplayStep[] = [];
  let lastCommitOk = false;
  // liveTx is tracked by runLiveSession via the setter; we don't need it here
  // beyond the closure shape the helper expects.
  let _liveTx: TxHandle | undefined;

  log.append({
    type: "session_start",
    ts: Date.now(),
    model: params.model,
    maxTurns: params.maxTurns,
    wallTimeMs: params.wallTimeMs,
    task: "freeform",
    actor
  });

  const injectIndex = params.injectModuleIndex !== false;
  let agentPrompt = params.prompt;
  let codebaseShapeSection: string | null = null;
  if (injectIndex) {
    const indexBody = buildModuleIndex(db, params.corpusRoot);
    codebaseShapeSection = `## Codebase shape\n\n${indexBody}`;
    log.append({
      type: "module_index_injected",
      ts: Date.now(),
      chars: indexBody.length,
      lines: indexBody.split("\n").length
    });
  }

  // Layer 3: retrieve up to K similar past commit patterns and inject them as
  // a "Past tasks like this one" section after the L1 codebase shape. On a
  // cold-start corpus (no prior commits) this is silently skipped — no empty
  // section, no log event — so the prompt looks exactly like L1+L2 today.
  const PAST_TASKS_K = 5;
  let pastTasks: PastTaskHit[] = [];
  if (embeddingProvider && isVecAvailable(db)) {
    try {
      pastTasks = await retrieveSimilarPastTasks(
        db,
        embeddingProvider,
        params.prompt,
        PAST_TASKS_K
      );
    } catch (err) {
      log.append({
        type: "past_tasks_failed",
        ts: Date.now(),
        reason: err instanceof Error ? err.message : String(err)
      });
      pastTasks = [];
    }
  }
  let pastTasksSection: string | null = null;
  if (pastTasks.length > 0) {
    const lines: string[] = ["## Past tasks like this one", ""];
    for (const hit of pastTasks) {
      lines.push(`- ${hit.prompt}`);
      lines.push(`  ops: ${hit.ops.join(", ")}`);
      lines.push(`  modules: ${hit.modules.join(", ")}`);
      lines.push(`  declarations: ${hit.declarations.join(", ")}`);
    }
    pastTasksSection = lines.join("\n");
    log.append({
      type: "past_tasks_injected",
      ts: Date.now(),
      count: pastTasks.length,
      k: PAST_TASKS_K
    });
  }

  agentPrompt = assembleAgentPrompt({
    codebaseShapeSection,
    pastTasksSection,
    userPrompt: params.prompt
  });

  const terminalReason = await runLiveSession({
    params: {
      corpusRoot: params.corpusRoot,
      model: params.model,
      maxTurns: params.maxTurns,
      wallTimeMs: params.wallTimeMs
    },
    prompt: agentPrompt,
    ctx,
    log,
    transcript,
    setLiveTx: (tx) => {
      _liveTx = tx;
    },
    setLastCommitOk: (ok) => {
      lastCommitOk = ok;
    }
  });

  const operationsAfter = (
    db.prepare("SELECT count(*) AS c FROM operations").get() as { c: number }
  ).c;

  return {
    terminalReason,
    log,
    transcript,
    dbPath: params.dbPath,
    newOperationsCount: operationsAfter - operationsBefore,
    lastCommitOk,
    totalOperationsCount: operationsAfter
  };
}

/**
 * Convenience: resolve task-specific behavioral fixtures by id, when the
 * caller wants the same gate the bench tasks use. For genuinely freeform
 * tasks, omit and let the gate run tsc-only.
 */
export function fixturesForBenchTask(taskId: string): readonly string[] {
  return behavioralFixturesForTask(taskId);
}
