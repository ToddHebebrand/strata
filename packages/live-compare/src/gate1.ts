// Gate 1 of the iteration-6 slice-A convergence frame: the two-arm, key-free
// semantic-parity harness. One arm is the SQLite product flow (in-memory only)
// with the T03-registered tsc-only gate; the other is the Rust coordination
// kernel driven through the daemon. Both ingest ONE corpus-input domain
// (`buildCorpusInputs`), so equal ingest implies equal node IDs, and every
// downstream parity check (nodes, references, rendered bytes, tsc+vitest, T03
// text criteria, normalized audit) tests genuine cross-arm semantic agreement.
//
// No model calls. No API keys. No persisted SQLite (":memory:" only). If a
// parity check fails on payload bytes after this harness is correct, that is a
// genuine semantic divergence (falsifier 1) — STOP and log a decision rather
// than weakening either arm.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compareCodeUnits,
  ingestBatch,
  parseCanonicalU64,
  type KernelSnapshotV1
} from "@strata-code/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  listModules,
  listOperationsByTx,
  loadModule,
  openDb,
  rename_symbol,
  rollback,
  type Db,
  type NodeRow
} from "@strata-code/store";
import {
  behavioralFixturesForTask,
  commit,
  tscNoEmit,
  validate,
  vitestRun
} from "@strata-code/verify";
import { exportSnapshot } from "@strata-code/kernel-bridge";
import { renderWithSourceMap } from "@strata-code/render";
import { CoordinationClient, type CoordinationResult } from "./client.js";
import { startKernelService } from "./service.js";
import { buildCorpusInputs, canonicalGenerationString } from "./tasks.js";

const packageRoot = resolve(__dirname, "..");
const repoRoot = resolve(packageRoot, "../..");

/** Key-free process env: never leak model credentials into the daemon or oracle. */
export function credentialFreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/**
 * The single task prompt passed to BOTH `begin(db, actor, TASK_PROMPT)` and
 * `beginChangeSet(TASK_PROMPT)`, so `taskContext` (the SQLite transaction's
 * triggering prompt / the kernel change set's reasoning) is byte-identical
 * across arms.
 */
export const TASK_PROMPT =
  "Rename the exported interface User to Account throughout the registered projection.";
/** The T03 rename target: exported alone so other harnesses (gate 2) reuse, not re-derive, it. */
export const OLD_NAME = "User";
export const NEW_NAME = "Account";
/**
 * The SQLite arm's transaction actor (the audit's `actor`, distinct from the
 * kernel clientId). Exported (export-only change) so gate-3's sqlite-child
 * worker reuses the same actor identity rather than re-deriving one.
 */
export const SQLITE_ARM_ACTOR = "sqlite-arm";

/**
 * Exported so other harnesses (gate 2) reuse gate 1's proven deadline budgets
 * instead of re-deriving their own. Both comfortably clear the daemon's
 * minimum coordination budgets (`session.rs` `MIN_BRIDGE_ANALYSIS_MS` =
 * 30.1 s for submit, `MIN_BRIDGE_PUBLICATION_MS` = 60.1 s for advance).
 */
export const DISCOVERY_DEADLINE_MS = 120_000;
export const SUBMIT_DEADLINE_MS = 120_000; // ≥120 s
export const ADVANCE_DEADLINE_MS = 180_000; // ≥180 s

export type Gate1Stage = "after_discovery" | "after_begin" | "after_add_intent" | "after_submit";

export interface NormalizedAudit {
  actor: string;
  taskContext: string;
  operationClass: "RenameSymbol";
  declarationId: string;
  oldName: string;
  newName: string;
  renamedIdentifierIds: string[];
}

export interface SqliteArmOutcome {
  snapshot: KernelSnapshotV1;
  audit: NormalizedAudit;
  renderedRoot: string;
}

export interface KernelArmOutcome {
  snapshot: KernelSnapshotV1;
  audit: NormalizedAudit;
  rawAffectedNodeIds: string[];
  renderedRoot: string;
  directory: string;
  operationId: string;
  changeSetId: string;
}

/** Re-export so gate1 is the single import surface for the corpus-input domain. */
export { buildCorpusInputs } from "./tasks.js";

/** Resolve the kernel-service binary: env override, else the default-features build. */
export function kernelServiceBinary(): string {
  return (
    process.env.STRATA_KERNEL_SERVICE_BIN ??
    join(repoRoot, "target/debug/strata-kernel-service")
  );
}

// ---------------------------------------------------------------------------
// Rendering — one code path for both arms (KernelSnapshotV1 -> scratch tree).
// ---------------------------------------------------------------------------

/**
 * Render a canonical snapshot to a fresh, self-contained corpus tree: each
 * Module node's committed statement payloads joined to text under its
 * corpus-relative path, plus the corpus's own tsconfig / package.json /
 * vitest.config.ts / tests and a node_modules symlink so `tscAndVitestGreen`
 * can run tsc and (scoped) vitest against it. Both arms route through here so
 * the rendered-bytes assertion compares like against like.
 */
export function renderSnapshotToTree(
  snapshot: KernelSnapshotV1,
  corpusRoot: string,
  outDir: string
): string {
  mkdirSync(outDir, { recursive: true });
  const db = openDb(":memory:");
  try {
    insertNodes(db, snapshot.nodes as unknown as NodeRow[]);
    for (const module of listModules(db)) {
      const loaded = loadModule(db, module.id);
      const text = renderWithSourceMap(loaded.module, loaded.children).text;
      // Module payload is the corpus-relative POSIX path (e.g. "src/types/user.ts").
      const dest = join(outDir, module.payload);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text, "utf8");
    }
  } finally {
    db.close();
  }

  for (const file of ["tsconfig.json", "package.json", "vitest.config.ts"]) {
    const from = join(corpusRoot, file);
    if (existsSync(from)) cpSync(from, join(outDir, file));
  }
  for (const dir of ["tests", "test"]) {
    const from = join(corpusRoot, dir);
    if (existsSync(from)) cpSync(from, join(outDir, dir), { recursive: true });
  }
  const treeNodeModules = join(outDir, "node_modules");
  if (!existsSync(treeNodeModules)) {
    const corpusNodeModules = join(corpusRoot, "node_modules");
    const repoNodeModules = join(repoRoot, "node_modules");
    if (existsSync(corpusNodeModules)) symlinkSync(corpusNodeModules, treeNodeModules, "dir");
    else if (existsSync(repoNodeModules)) symlinkSync(repoNodeModules, treeNodeModules, "dir");
  }
  return outDir;
}

/**
 * The gate-1 harness quality check: run tsc --noEmit AND vitest identically on
 * a rendered tree. Reuses `@strata-code/verify`'s corpusRun runners. The T03
 * task profile registers an empty behavioral-fixture list
 * (`taskBehavioralFixtures.ts` `T03: []`), so vitest is scoped to zero files
 * and passes trivially — the harness check reduces to tsc-only, applied the
 * same way to both arms. (The corpus's own discoverable test files are T01/T05
 * fixtures, red-by-design for other tasks and outside T03's scope.)
 */
export async function tscAndVitestGreen(treeRoot: string): Promise<boolean> {
  const tsc = tscNoEmit(treeRoot);
  const vitest = vitestRun(treeRoot, behavioralFixturesForTask("T03"));
  return tsc.tscClean && vitest.vitestPassed;
}

// ---------------------------------------------------------------------------
// SQLite product arm.
// ---------------------------------------------------------------------------

export async function runSqliteArm(corpusRoot: string): Promise<SqliteArmOutcome> {
  const resolved = resolve(corpusRoot);
  const batch = ingestBatch(buildCorpusInputs(resolved));
  const db = openDb(":memory:");
  try {
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const declarations = find_declarations(db, { name: OLD_NAME, kind: "interface" });
    if (declarations.length !== 1) {
      throw new Error(
        `SQLite arm expected exactly one interface named ${OLD_NAME}; got ${declarations.length}`
      );
    }
    const declarationId = declarations[0]!.id;

    // Actor first, TASK_PROMPT as the transaction's triggering prompt: the
    // audit's taskContext is that prompt, identical to the kernel change set's
    // reasoning.
    const tx = begin(db, SQLITE_ARM_ACTOR, TASK_PROMPT);
    rename_symbol(db, tx, declarationId, NEW_NAME);
    // Node IDs derive from the corpus-RELATIVE module payloads (the shared
    // input domain), but tsconfig discovery + module resolution need physical
    // paths — so commit/validate physicalize the relative keys against the
    // corpus root (exactly how commitWithBehavioralGate uses moduleBaseDir).
    const commitResult = commit(db, tx, resolved);
    if (!commitResult.ok) {
      throw new Error(
        `SQLite arm commit failed: ${JSON.stringify(commitResult.diagnostics)}`
      );
    }

    // Post-commit re-validate on a throwaway tx (tsc-only, exactly the product
    // T03 gate in packages/cli/src/commands/t03.ts).
    const checkTx = begin(db, SQLITE_ARM_ACTOR);
    const postCommitDiagnostics = validate(db, checkTx, resolved);
    rollback(db, checkTx);
    if (postCommitDiagnostics.length !== 0) {
      throw new Error(
        `SQLite arm post-commit validate was not clean: ${JSON.stringify(postCommitDiagnostics)}`
      );
    }

    const snapshot = normalizeSnapshot(exportSnapshot(db, parseCanonicalU64("1")));

    // Audit projection: the operations row (snake_case params, affected
    // Identifier IDs) joined with the transaction's triggering prompt.
    const operations = listOperationsByTx(db, tx.id);
    if (operations.length !== 1) {
      throw new Error(`SQLite arm expected exactly one operation row; got ${operations.length}`);
    }
    const operation = operations[0]!;
    const params = JSON.parse(operation.paramsJson) as {
      declaration_id: string;
      old_name: string;
      new_name: string;
    };
    const affected = JSON.parse(operation.affectedNodeIdsJson) as string[];
    const promptRow = db
      .prepare("SELECT triggering_prompt AS prompt FROM transactions WHERE tx_id = ?")
      .get(tx.id) as { prompt: string | null } | undefined;

    const audit: NormalizedAudit = {
      actor: operation.actor,
      taskContext: promptRow?.prompt ?? "",
      operationClass: "RenameSymbol",
      declarationId: params.declaration_id,
      oldName: params.old_name,
      newName: params.new_name,
      renamedIdentifierIds: [...affected].sort(compareCodeUnits)
    };

    const renderedRoot = renderSnapshotToTree(
      snapshot,
      resolved,
      mkdtempSync(join(tmpdir(), "strata-gate1-sqlite-"))
    );

    return { snapshot, audit, renderedRoot };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Kernel coordination arm.
// ---------------------------------------------------------------------------

export async function runKernelArmT03(
  corpusRoot: string,
  options?: {
    directory?: string;
    extraArgs?: string[];
    clientId?: string;
    onStage?: (
      stage: Gate1Stage,
      ctx: {
        client: CoordinationClient;
        socketPath: string;
        changeSetId?: string;
        declarationId?: string;
      }
    ) => Promise<void>;
    stopAfterSubmit?: boolean;
    preserveDirectory?: boolean;
  }
): Promise<KernelArmOutcome> {
  const resolved = resolve(corpusRoot);
  const preserveDirectory = options?.preserveDirectory ?? false;
  const service = await startKernelService(resolved, {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    ...(options?.directory !== undefined ? { directory: options.directory } : {}),
    ...(options?.extraArgs !== undefined ? { extraArgs: options.extraArgs } : {})
  });
  // The change-set actor is the clientId that calls begin_change_set, and
  // advance/cancel are actor-scoped (session.rs authorize_actor). The crash
  // suite prepares the change set here, then restarts and must issue the
  // advance from the SAME actor — so it supplies a known clientId to reuse.
  const client = new CoordinationClient({
    socketPath: service.socketPath,
    clientId: options?.clientId ?? `gate1-kernel-arm:${randomUUID()}`
  });

  let stopped = false;
  const stop = async (opts?: { preserveDirectory?: boolean }): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await service.stop(opts);
  };

  try {
    // Discovery: the kernel find_declarations nodeId must equal the SQLite
    // declaration id (same ingest domain).
    const discovery = expectResult(
      await client.findDeclarations(OLD_NAME, "interface", DISCOVERY_DEADLINE_MS),
      "declarations"
    );
    if (discovery.declarations.length !== 1) {
      throw new Error(
        `Kernel arm expected exactly one interface named ${OLD_NAME}; got ${discovery.declarations.length}`
      );
    }
    const declarationId = discovery.declarations[0]!.nodeId;
    await options?.onStage?.("after_discovery", {
      client,
      socketPath: service.socketPath,
      declarationId
    });

    const begun = expectResult(
      await client.beginChangeSet(TASK_PROMPT, SUBMIT_DEADLINE_MS),
      "change_set"
    );
    const changeSetId = begun.changeSetId;
    await options?.onStage?.("after_begin", {
      client,
      socketPath: service.socketPath,
      changeSetId,
      declarationId
    });

    await client.addIntent(
      changeSetId,
      { type: "rename_symbol", declarationId, newName: NEW_NAME },
      SUBMIT_DEADLINE_MS
    );
    await options?.onStage?.("after_add_intent", {
      client,
      socketPath: service.socketPath,
      changeSetId,
      declarationId
    });

    expectResult(await client.submitChangeSet(changeSetId, SUBMIT_DEADLINE_MS), "change_set");
    await options?.onStage?.("after_submit", {
      client,
      socketPath: service.socketPath,
      changeSetId,
      declarationId
    });

    // Task 7 crash choreography: prep only (begin/add/submit committed to
    // durable state), clean stop preserving the redb, no advance. Returns what
    // is known; snapshot/audit/render are neutral placeholders the crash suite
    // does not consume. `declarationId` is attached as an extra runtime field
    // for the crash suite's convenience (KernelArmOutcome has no such field).
    if (options?.stopAfterSubmit) {
      await stop({ preserveDirectory: true });
      const known: KernelArmOutcome & { declarationId: string } = {
        snapshot: { schemaVersion: 1, generation: parseCanonicalU64("0"), nodes: [], references: [] },
        audit: neutralAudit(),
        rawAffectedNodeIds: [],
        renderedRoot: "",
        directory: service.directory,
        operationId: "",
        changeSetId,
        declarationId
      };
      return known;
    }

    const advanced = expectResult(
      await client.advanceChangeSet(changeSetId, ADVANCE_DEADLINE_MS),
      "change_set"
    );
    if (advanced.state !== "published" || advanced.operationId === null) {
      throw new Error(
        `Kernel arm advance did not commit: ${JSON.stringify({
          state: advanced.state,
          operationId: advanced.operationId
        })}`
      );
    }
    const operationId = advanced.operationId;

    const operation = expectResult(
      await client.readOperation(operationId, DISCOVERY_DEADLINE_MS),
      "operation"
    );

    // Stop preserving the redb so the offline export oracle can read it.
    await stop({ preserveDirectory: true });

    const exported = exportKernelSnapshot(service.directory);
    const snapshot = normalizeSnapshot(exported.snapshot);

    // renamedIdentifierIds = the renamed Identifier-kind members of the
    // operation's affectedNodeIds, resolved against the exported graph. The
    // kernel's delta upserts EVERY identifier in a changed statement — the
    // renamed ones (text -> the new name) AND siblings whose offset merely
    // shifted (unchanged text) — so the bare Identifier-kind subset is broader
    // than the SQLite operation's semantic `affected` list. We narrow to the
    // identifiers whose final text is the new name; because the graphs are
    // byte-identical (assertion 1) and the new name is introduced only by this
    // rename, that is exactly the set the SQLite arm records. The full
    // affectedNodeIds (statements + offset-shifted identifiers) is retained as
    // rawAffectedNodeIds and asserted separately as the superset.
    const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const renamedIdentifierIds = [...operation.affectedNodeIds]
      .filter((id) => {
        const node = nodeById.get(id);
        if (!node || node.kind !== "Identifier") return false;
        try {
          return (JSON.parse(node.payload) as { text?: string }).text === NEW_NAME;
        } catch {
          return false;
        }
      })
      .sort(compareCodeUnits);

    const renameIntent = operation.intents.find((intent) => intent.kind === "RenameSymbol");
    if (!renameIntent) {
      throw new Error(`Kernel arm operation carried no RenameSymbol intent: ${operationId}`);
    }
    const intentParams = JSON.parse(renameIntent.parametersJson) as {
      declarationId: string;
      newName: string;
    };
    const rename0 = operation.renames[0];
    if (!rename0) {
      throw new Error(`Kernel arm operation carried no rename transition: ${operationId}`);
    }

    const audit: NormalizedAudit = {
      actor: operation.actor,
      taskContext: operation.reasoning,
      operationClass: "RenameSymbol",
      declarationId: intentParams.declarationId,
      oldName: rename0.fromName,
      newName: intentParams.newName,
      renamedIdentifierIds
    };

    const renderedRoot = renderSnapshotToTree(
      snapshot,
      resolved,
      mkdtempSync(join(tmpdir(), "strata-gate1-kernel-"))
    );

    const outcome: KernelArmOutcome = {
      snapshot,
      audit,
      rawAffectedNodeIds: [...operation.affectedNodeIds],
      renderedRoot,
      directory: service.directory,
      operationId,
      changeSetId
    };

    if (!preserveDirectory) {
      // The service is already stopped preserving the directory (needed for the
      // export); honor preserveDirectory: false by removing it now.
      const { rmSync } = await import("node:fs");
      rmSync(service.directory, { recursive: true, force: true });
    }
    return outcome;
  } finally {
    // If we threw before an explicit stop, tear down; keep the directory when
    // the caller asked to preserve it (or when stopAfterSubmit already stopped).
    await stop({ preserveDirectory });
  }
}

// ---------------------------------------------------------------------------
// Offline export oracle.
// ---------------------------------------------------------------------------

interface RawGraphSnapshot {
  schemaVersion: number;
  generation: number;
  nodes: { id: string; kind: string; parentId: string | null; childIndex: number | null; payload: string }[];
  references: { fromNodeId: string; toNodeId: string; kind: string }[];
}

/**
 * Run the daemon's offline `export-snapshot` subcommand over the preserved
 * redb and normalize it to a canonical `KernelSnapshotV1`. The Rust
 * `GraphSnapshot` serializes generation as a JSON number; the harness converts
 * it to a canonical decimal string via `canonicalGenerationString`. Node and
 * reference parity never involves the generation field.
 */
export function exportKernelSnapshot(
  directory: string,
  options?: { stateOut?: string }
): { snapshot: KernelSnapshotV1; generation: string; digest: string } {
  const binary = kernelServiceBinary();
  const outFile = join(mkdtempSync(join(tmpdir(), "strata-gate1-export-")), "snapshot.json");
  const args = ["export-snapshot", "--db", join(directory, "kernel.redb"), "--out", outFile];
  if (options?.stateOut) args.push("--state-out", options.stateOut);
  const stdout = execFileSync(binary, args, {
    cwd: repoRoot,
    env: credentialFreeEnv(),
    encoding: "utf8"
  });
  const reported = JSON.parse(stdout) as { generation: string; digest: string };
  const raw = JSON.parse(readFileSync(outFile, "utf8")) as RawGraphSnapshot;
  const generation = canonicalGenerationString(raw.generation);
  if (generation !== reported.generation) {
    throw new Error(
      `export-snapshot generation mismatch: file ${generation} vs stdout ${reported.generation}`
    );
  }
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    generation: parseCanonicalU64(generation),
    nodes: raw.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      childIndex: node.childIndex,
      payload: node.payload
    })),
    references: raw.references.map((reference) => ({
      fromNodeId: reference.fromNodeId,
      toNodeId: reference.toNodeId,
      kind: reference.kind
    }))
  });
  return { snapshot, generation: reported.generation, digest: reported.digest };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Sort nodes by id and references by (from, to, kind) so byte comparison is order-stable. */
function normalizeSnapshot(snapshot: KernelSnapshotV1): KernelSnapshotV1 {
  return {
    schemaVersion: 1,
    generation: snapshot.generation,
    nodes: [...snapshot.nodes].sort((a, b) => compareCodeUnits(a.id, b.id)),
    references: [...snapshot.references].sort(
      (a, b) =>
        compareCodeUnits(a.fromNodeId, b.fromNodeId) ||
        compareCodeUnits(a.toNodeId, b.toNodeId) ||
        compareCodeUnits(a.kind, b.kind)
    )
  };
}

function neutralAudit(): NormalizedAudit {
  return {
    actor: "",
    taskContext: "",
    operationClass: "RenameSymbol",
    declarationId: "",
    oldName: OLD_NAME,
    newName: NEW_NAME,
    renamedIdentifierIds: []
  };
}

/** Unwrap a coordination result to a specific variant, or throw. Exported so other harnesses (gate 2) reuse it rather than re-implementing the same narrowing. */
export function expectResult<T extends CoordinationResult["type"]>(
  result: CoordinationResult,
  type: T
): Extract<CoordinationResult, { type: T }> {
  if (result.type !== type) {
    throw new Error(`Expected a ${type} coordination result; got ${result.type}`);
  }
  return result as Extract<CoordinationResult, { type: T }>;
}
