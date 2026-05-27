import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { behavioralFixturesForTask } from "@strata/verify";
import {
  insertNodes,
  insertReferences,
  openDb,
  type TxHandle
} from "@strata/store";
import { SessionLog } from "./log";
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
    acceptance: {
      corpusRoot: params.corpusRoot,
      srcRoot,
      behavioralFixtures: params.behavioralFixtures ?? []
    }
  };

  const log = new SessionLog(params.logPath);
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

  const terminalReason = await runLiveSession({
    params: {
      corpusRoot: params.corpusRoot,
      model: params.model,
      maxTurns: params.maxTurns,
      wallTimeMs: params.wallTimeMs
    },
    prompt: params.prompt,
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
