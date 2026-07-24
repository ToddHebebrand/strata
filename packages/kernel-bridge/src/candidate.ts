import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseCanonicalU64, type KernelSnapshotV1 } from "@strata-code/ingest";
import {
  add_parameter,
  begin,
  findNodeById,
  getReferencesByTo,
  resolveDeclarationNameIdentifier,
  rename_symbol,
  rollback,
  type Db,
  type TxHandle
} from "@strata-code/store";
import { commit, commitWithBehavioralGate, type Diagnostic } from "@strata-code/verify";
import { StageRecorder } from "./metrics";
import { mirrorFingerprint } from "./mirror-fingerprint";
import {
  type BridgeDiagnostic,
  type BridgeErrorPayload,
  type BuildValidateCandidateRequest,
  type KernelGraphDeltaV1,
  type ValidationProfile
} from "./protocol";
import { diffSnapshots, exportSnapshot, hydrateSnapshot } from "./snapshot";
import type { MirrorCandidateRequest } from "./sync";

const MAX_MESSAGE_CODE_UNITS = 1_000;
const MAX_DIAGNOSTIC_CODE_UNITS = 64 * 1_024;
const MAX_DIAGNOSTICS = 256;

export type CandidateSuccess = {
  delta: KernelGraphDeltaV1;
  diagnostics: [];
};

export type BuildValidateCandidateResult = CandidateSuccess | BridgeErrorPayload;

class CandidateFailure extends Error {
  constructor(
    readonly stage: BridgeErrorPayload["stage"],
    readonly code: string,
    readonly diagnostics: BridgeDiagnostic[],
    message: string
  ) {
    super(message);
  }
}

export function buildValidateCandidate(
  request: BuildValidateCandidateRequest,
  recorder?: StageRecorder
): BuildValidateCandidateResult {
  const profileError = validateProfile(request.validationProfile, request.snapshot);
  if (profileError !== undefined) return profileError;

  let db: Db;
  try {
    db = recorder
      ? recorder.time("hydrate", () => hydrateSnapshot(request.snapshot))
      : hydrateSnapshot(request.snapshot);
  } catch (error) {
    return errorPayload("hydrate", "invalidSnapshot", error, []);
  }

  try {
    return buildValidateCandidateInScratch(request, db, recorder);
  } finally {
    db.close();
  }
}

/**
 * Package-internal seam for proving rollback against the exact hydrated graph.
 * The package barrel intentionally does not export it.
 */
export function buildValidateCandidateInScratch(
  request: BuildValidateCandidateRequest,
  db: Db,
  recorder?: StageRecorder
): BuildValidateCandidateResult {
  let tx: TxHandle | undefined;
  const touchedStatementIds = new Set<string>();
  let stage: BridgeErrorPayload["stage"] = "mutate";
  const bracket = <T>(bracketStage: "mutate" | "validate" | "export", fn: () => T): T =>
    recorder ? recorder.time(bracketStage, fn) : fn();

  try {
    const activeTx = begin(db, request.changeSet.actor, request.changeSet.reasoning);
    tx = activeTx;
    bracket("mutate", () => {
      for (const intent of request.changeSet.orderedIntents) {
        if (intent.parameters.type === "renameSymbol") {
          collectRenameTouchedStatements(
            db,
            intent.parameters.declarationId,
            touchedStatementIds
          );
          rename_symbol(
            db,
            activeTx,
            intent.parameters.declarationId,
            intent.parameters.newName
          );
        } else {
          const manifest = add_parameter(
            db,
            activeTx,
            intent.parameters.functionId,
            intent.parameters.name,
            intent.parameters.typeText,
            intent.parameters.position,
            intent.parameters.defaultValue ?? undefined
          );
          touchedStatementIds.add(manifest.declaration.id);
          for (const callsite of manifest.callsitesRewritten) {
            touchedStatementIds.add(callsite.statementId);
          }
        }
      }
    });

    stage = "validate";
    const commitResult = bracket("validate", () =>
      request.validationProfile.mode === "tscOnly"
        ? commit(db, activeTx, request.validationProfile.corpusRoot)
        : commitWithBehavioralGate(db, activeTx, {
            srcRoot: request.validationProfile.sourceRoot,
            corpusRoot: request.validationProfile.corpusRoot,
            behavioralFixtures: request.validationProfile.behavioralFixtures,
            strictSrcOnlyTscScope:
              request.validationProfile.strictSrcOnlyTscScope
          })
    );
    if (!commitResult.ok) {
      if ("diagnostics" in commitResult) {
        throw new CandidateFailure(
          "validate",
          "typescriptFailed",
          normalizeDiagnostics(commitResult.diagnostics),
          "candidate TypeScript validation failed"
        );
      }
      throw new CandidateFailure(
        "validate",
        "behavioralFailed",
        normalizeDiagnostics([
          {
            nodeId: null,
            modulePath: null,
            message: commitResult.testFailures,
            code: 1
          }
        ]),
        "candidate behavioral validation failed"
      );
    }

    stage = "export";
    // `exportNs` covers only the two bracketed calls below (snapshot export
    // and delta diffing); the validateCandidateIdentity(...) call between
    // them is deliberately left unmeasured here -- it's a graph-identity
    // check, not serialization work, so folding it in would overstate the
    // export stage's cost.
    const after = bracket("export", () =>
      exportSnapshot(
        db,
        parseCanonicalU64((BigInt(request.snapshot.generation) + 1n).toString())
      )
    );
    const identityError = validateCandidateIdentity(
      request.snapshot,
      after,
      touchedStatementIds
    );
    if (identityError !== undefined) return identityError;
    return {
      delta: bracket("export", () => diffSnapshots(request.snapshot, after)),
      diagnostics: []
    };
  } catch (error) {
    rollbackIfOpen(db, tx);
    if (error instanceof CandidateFailure) {
      return errorPayload(error.stage, error.code, error, error.diagnostics);
    }
    const code =
      stage === "mutate"
        ? "mutationFailed"
        : stage === "validate"
          ? "candidateFinalizeFailed"
          : "candidateExportFailed";
    return errorPayload(stage, code, error, []);
  }
}

/** The candidate pipeline signature the mirror wrapper brackets (test seam). */
export type CandidatePipeline = (
  request: BuildValidateCandidateRequest,
  db: Db,
  recorder?: StageRecorder
) => BuildValidateCandidateResult;

export type MirrorCandidateOutcome =
  | { kind: "served"; result: BuildValidateCandidateResult }
  | { kind: "poisoned"; detail: string };

/**
 * Runs the UNCHANGED candidate pipeline against the persistent mirror under
 * savepoint-rollback isolation (bridge-persistence slice, Task 7).
 *
 * Contract, in order:
 * 1. pre-fingerprint — the full logical {@link mirrorFingerprint} over ALL
 *    mutable tables + integrity pragmas (strictly stronger than the sync
 *    digest: candidate execution also writes transactions/operations rows);
 * 2. `SAVEPOINT candidate`; export the attested mirror content as the
 *    request snapshot the pipeline diffs against (the same bytes an in-band
 *    snapshot would carry — the mirror IS the published generation by
 *    attestation), then run the exact one-shot pipeline:
 *    profile validation + `buildValidateCandidateInScratch` (its
 *    begin/mutate/validate/commit all land inside the savepoint; nested
 *    better-sqlite3 `db.transaction()` calls stack as inner savepoints);
 * 3. `ROLLBACK TO candidate; RELEASE candidate` — ALWAYS: success, semantic
 *    failure, and thrown-exception paths all unwind through the `finally`;
 * 4. post-fingerprint must equal the pre-fingerprint. Any divergence (or a
 *    rollback/fingerprint failure itself) POISONS: the caller must refuse
 *    all further work so the host kills + respawns + full-rehydrates.
 *
 * Isolation scope note: the pipeline's only out-of-SQLite side effects are
 * the rendered-tree temp dirs the verify gate creates per run (transient,
 * identical on the one-shot path) and the store's module-level transaction
 * overlay map, which the pipeline itself closes on every path and which the
 * isolation gates assert stays at its baseline (`openTransactionOverlayCount`).
 *
 * `pipeline` is a test seam (poison-state gate: a pipeline that COMMITs
 * behind the wrapper's back must be detected); production callers omit it.
 */
export function buildValidateCandidateOnMirror(
  request: MirrorCandidateRequest,
  db: Db,
  recorder?: StageRecorder,
  pipeline?: CandidatePipeline
): MirrorCandidateOutcome {
  const generation = request.identity.generation;
  const run: CandidatePipeline = pipeline ?? buildValidateCandidateInScratch;

  let pre: string;
  try {
    pre = mirrorFingerprint(db, generation);
  } catch (error) {
    return poisoned("pre-candidate fingerprint failed", error);
  }

  let result: BuildValidateCandidateResult;
  let unwindFailure: unknown;
  db.exec("SAVEPOINT candidate");
  try {
    // The "before" snapshot is exported from the mirror itself: by
    // attestation it is byte-equal (post-sort) to the snapshot the one-shot
    // request would have carried in-band for this published generation.
    const snapshot = exportSnapshot(db, generation);
    const fullRequest: BuildValidateCandidateRequest = {
      protocolVersion: 1,
      requestId: request.requestId,
      kind: "buildValidateCandidate",
      binding: request.binding,
      snapshot,
      attemptId: request.attemptId,
      scopeFingerprint: request.scopeFingerprint,
      changeSet: request.changeSet,
      validationProfile: request.validationProfile
    };
    const profileError = validateProfile(request.validationProfile, snapshot);
    result = profileError ?? run(fullRequest, db, recorder);
  } catch (error) {
    // The pipeline normally reports failures as payloads; anything that
    // still throws (snapshot export, a seam, a store invariant) becomes an
    // error payload AFTER the savepoint unwinds below.
    result = errorPayload("mutate", "mirrorCandidateFailed", error, []);
  } finally {
    try {
      db.exec("ROLLBACK TO candidate");
      db.exec("RELEASE candidate");
    } catch (error) {
      unwindFailure = error;
    }
  }
  if (unwindFailure !== undefined) {
    return poisoned("candidate savepoint rollback failed", unwindFailure);
  }

  let post: string;
  try {
    post = mirrorFingerprint(db, generation);
  } catch (error) {
    return poisoned("post-candidate fingerprint failed", error);
  }
  if (post !== pre) {
    return {
      kind: "poisoned",
      detail:
        `mirror fingerprint diverged across candidate ${request.attemptId}: ` +
        `pre ${pre} != post ${post}`
    };
  }
  return { kind: "served", result };
}

function poisoned(context: string, error: unknown): MirrorCandidateOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "poisoned", detail: `${context}: ${normalizeMessage(message)}` };
}

/**
 * TEST-ONLY pipeline seam for the poison-state gate (plan review Minor 2):
 * releases the wrapper's savepoint early — committing a deliberate
 * corruption behind its back — then reopens a same-named savepoint so the
 * wrapper's unwind "succeeds" while the corruption survives. The wrapper's
 * post-fingerprint MUST catch this. Selected in the worker only via the
 * `STRATA_TEST_MIRROR_CANDIDATE_CORRUPT=1` environment seam; never used in
 * production paths (the package barrel does not export it).
 */
export function corruptingMirrorPipelineForTests(
  request: BuildValidateCandidateRequest,
  db: Db,
  recorder?: StageRecorder
): BuildValidateCandidateResult {
  db.exec("RELEASE candidate");
  db.prepare(
    `UPDATE nodes SET payload = payload || ' /* corrupted-behind-savepoint */'
     WHERE id = (SELECT id FROM nodes ORDER BY id LIMIT 1)`
  ).run();
  db.exec("SAVEPOINT candidate");
  return buildValidateCandidateInScratch(request, db, recorder);
}

/** Package-internal identity validator, exposed only for corruption regressions. */
export function validateCandidateIdentity(
  before: KernelSnapshotV1,
  after: KernelSnapshotV1,
  touchedStatementIds: ReadonlySet<string>
): BridgeErrorPayload | undefined {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));

  const stableBefore = before.nodes.filter((node) => node.kind !== "Identifier");
  const stableAfter = after.nodes.filter((node) => node.kind !== "Identifier");
  if (
    stableBefore.length !== stableAfter.length ||
    stableBefore.some((node, index) => {
      const next = stableAfter[index];
      return (
        next === undefined ||
        next.id !== node.id ||
        next.kind !== node.kind ||
        next.parentId !== node.parentId ||
        next.childIndex !== node.childIndex
      );
    })
  ) {
    return unexpectedIdChurn("declaration or statement identity changed");
  }

  for (const node of before.nodes) {
    if (node.kind !== "Identifier" || touchedStatementIds.has(node.parentId ?? "")) {
      continue;
    }
    if (!sameNode(node, afterById.get(node.id))) {
      return unexpectedIdChurn(
        `identifier ${node.id} changed outside a touched statement`
      );
    }
  }
  for (const node of after.nodes) {
    if (node.kind !== "Identifier" || touchedStatementIds.has(node.parentId ?? "")) {
      continue;
    }
    if (!sameNode(node, beforeById.get(node.id))) {
      return unexpectedIdChurn(
        `identifier ${node.id} appeared outside a touched statement`
      );
    }
  }
  return undefined;
}

function collectRenameTouchedStatements(
  db: Db,
  declarationId: string,
  touched: Set<string>
): void {
  touched.add(declarationId);
  const name = resolveDeclarationNameIdentifier(db, declarationId);
  if (name === undefined) return;
  for (const reference of getReferencesByTo(db, name.id)) {
    const source = findNodeById(db, reference.fromNodeId);
    if (source?.parentId !== null && source?.parentId !== undefined) {
      touched.add(source.parentId);
    }
  }
}

function validateProfile(
  profile: ValidationProfile,
  snapshot: KernelSnapshotV1
): BridgeErrorPayload | undefined {
  try {
    if (
      !existsSync(profile.corpusRoot) ||
      !statSync(profile.corpusRoot).isDirectory() ||
      !existsSync(profile.sourceRoot) ||
      !statSync(profile.sourceRoot).isDirectory()
    ) {
      throw new Error("sourceRoot and corpusRoot must be existing directories");
    }
    const corpusRoot = realpathSync(profile.corpusRoot);
    const sourceRoot = realpathSync(profile.sourceRoot);
    if (!isWithin(corpusRoot, sourceRoot)) {
      throw new Error("sourceRoot must be contained by corpusRoot");
    }

    for (const module of snapshot.nodes.filter((node) => node.kind === "Module")) {
      const resolvedModulePath = path.resolve(corpusRoot, module.payload);
      const modulePath = existsSync(resolvedModulePath)
        ? realpathSync(resolvedModulePath)
        : resolvedModulePath;
      if (!isWithin(sourceRoot, modulePath)) {
        return errorPayload(
          "validate",
          "moduleOutsideSourceRoot",
          new Error(`module ${module.payload} is outside sourceRoot`),
          []
        );
      }
    }

    if (profile.mode === "behavioral") {
      if (profile.behavioralFixtures.length === 0) {
        return errorPayload(
          "validate",
          "invalidBehavioralFixtures",
          new Error("behavioral validation requires an explicit fixture"),
          []
        );
      }
      for (const fixture of profile.behavioralFixtures) {
        if (path.isAbsolute(fixture)) {
          return invalidBehavioralFixture("behavioral fixture must be relative");
        }
        const fixturePath = path.resolve(corpusRoot, fixture);
        if (!isWithin(corpusRoot, fixturePath) || !existsSync(fixturePath)) {
          return invalidBehavioralFixture(
            `behavioral fixture is missing or outside corpusRoot: ${fixture}`
          );
        }
        const realFixture = realpathSync(fixturePath);
        const relativeFixture = path.relative(corpusRoot, realFixture);
        const firstSegment = relativeFixture.split(path.sep)[0];
        if (
          !isWithin(corpusRoot, realFixture) ||
          !statSync(realFixture).isFile() ||
          (firstSegment !== "test" && firstSegment !== "tests") ||
          !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativeFixture)
        ) {
          return invalidBehavioralFixture(
            `behavioral fixture is not a trusted file: ${fixture}`
          );
        }
      }
    }
    return undefined;
  } catch (error) {
    return errorPayload("validate", "invalidValidationProfile", error, []);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function invalidBehavioralFixture(message: string): BridgeErrorPayload {
  return errorPayload(
    "validate",
    "invalidBehavioralFixtures",
    new Error(message),
    []
  );
}

function unexpectedIdChurn(message: string): BridgeErrorPayload {
  return errorPayload("export", "unexpectedIdChurn", new Error(message), []);
}

function rollbackIfOpen(db: Db, tx: TxHandle | undefined): void {
  if (tx === undefined) return;
  try {
    rollback(db, tx);
  } catch {
    // A successful finalize closes the scratch transaction. At that point the
    // disposable database is discarded if export fails; there is no open
    // overlay left to roll back.
  }
}

function sameNode(
  left: KernelSnapshotV1["nodes"][number],
  right: KernelSnapshotV1["nodes"][number] | undefined
): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.kind === right.kind &&
    left.parentId === right.parentId &&
    left.childIndex === right.childIndex &&
    left.payload === right.payload
  );
}

function normalizeDiagnostics(
  diagnostics: readonly (Diagnostic | BridgeDiagnostic)[]
): BridgeDiagnostic[] {
  const normalized: BridgeDiagnostic[] = [];
  let remaining = MAX_DIAGNOSTIC_CODE_UNITS;
  for (const diagnostic of diagnostics) {
    if (remaining <= 0 || normalized.length >= MAX_DIAGNOSTICS) break;
    const normalizedPath =
      diagnostic.modulePath === null
        ? null
        : normalizeMessage(diagnostic.modulePath).slice(
            0,
            Math.min(MAX_MESSAGE_CODE_UNITS, remaining)
          );
    remaining -= normalizedPath?.length ?? 0;
    const message = normalizeMessage(diagnostic.message).slice(0, remaining);
    remaining -= message.length;
    normalized.push({
      nodeId: diagnostic.nodeId,
      modulePath: normalizedPath,
      message,
      code: diagnostic.code
    });
  }
  return normalized;
}

function errorPayload(
  stage: BridgeErrorPayload["stage"],
  code: string,
  error: unknown,
  diagnostics: readonly BridgeDiagnostic[]
): BridgeErrorPayload {
  return {
    stage,
    code,
    message: normalizeMessage(error instanceof Error ? error.message : String(error)),
    diagnostics: normalizeDiagnostics(diagnostics)
  };
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CODE_UNITS);
}
