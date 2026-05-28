import { existsSync } from "node:fs";
import path from "node:path";
import { renderWithSourceMap, type SourceMapEntry } from "@strata/render";
import { runCorpusAcceptance } from "./corpusRun";
import {
  commitWithoutValidate,
  emitIdentifiersForInserted,
  getOverlay,
  isNoop,
  listModules,
  loadModule,
  planMaterialization,
  reDeriveChangedStatements,
  refreshReferenceEdges,
  type Db,
  type NodeRow,
  type TxHandle
} from "@strata/store";
import ts from "typescript";

export interface Diagnostic {
  nodeId: string | null;
  modulePath: string | null;
  message: string;
  code: number;
}

export type CommitResult =
  | { ok: true }
  | { ok: false; diagnostics: Diagnostic[] };

export function renderPendingModules(
  db: Db,
  tx: TxHandle
): {
  renderedFiles: Map<string, string>;
  sourceMaps: Map<string, SourceMapEntry[]>;
} {
  const overlay = getOverlay(tx);
  const renderedFiles = new Map<string, string>();
  const sourceMaps = new Map<string, SourceMapEntry[]>();

  for (const module of listModules(db)) {
    const loaded = loadModuleForRender(db, module.id);
    const { text, sourceMap } = renderWithSourceMap(
      loaded.module,
      loaded.children,
      {
        identifierMutations: overlay.identifierMutations,
        textSpanMutations: overlay.textSpanMutations
      }
    );
    renderedFiles.set(normalizeFileName(module.payload), text);
    sourceMaps.set(normalizeFileName(module.payload), sourceMap);
  }

  return { renderedFiles, sourceMaps };
}

export function validate(db: Db, tx: TxHandle): Diagnostic[] {
  const { renderedFiles, sourceMaps } = renderPendingModules(db, tx);

  const options = loadCompilerOptions([...renderedFiles.keys()]);
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) =>
    renderedFiles.has(normalizeFileName(fileName)) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    renderedFiles.get(normalizeFileName(fileName)) ?? ts.sys.readFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile
  ) => {
    const rendered = renderedFiles.get(normalizeFileName(fileName));
    if (rendered !== undefined) {
      return ts.createSourceFile(
        fileName,
        rendered,
        languageVersionOrOptions,
        true,
        ts.ScriptKind.TS
      );
    }
    return originalGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile
    );
  };
  // Override resolveModuleNames so relative imports resolve against in-memory
  // files rather than the real filesystem. Without this, a module like `./b`
  // imported by `/project/a.ts` would fail when `/project/b.ts` only exists
  // in renderedFiles and not on disk.
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      if (moduleName.startsWith(".")) {
        const dir = path.dirname(containingFile);
        for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
          const candidate = normalizeFileName(path.join(dir, moduleName + ext));
          if (renderedFiles.has(candidate)) {
            return { resolvedFileName: candidate, isExternalLibraryImport: false };
          }
        }
      }
      const result = ts.resolveModuleName(moduleName, containingFile, options, host);
      return result.resolvedModule;
    });

  const program = ts.createProgram({
    rootNames: [...renderedFiles.keys()],
    options,
    host
  });

  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => mapDiagnostic(diagnostic, sourceMaps));
}

/**
 * Narrow the resolver's program input to dirty modules + the modules they
 * import, so a 1-dirty-module commit on a large corpus does not build a program
 * over every module. Conservative: over-inclusion is safe; under-inclusion only
 * drops a cross-module edge that self-heals when the referencing module next
 * commits. A regex import scan (not full module resolution) — adequate here.
 *
 * Relative import specifiers (starting with `.`) are resolved using path.join
 * against the dirty module's directory, so both `./foo` and `../bar` style
 * imports are correctly included. Non-relative (bare/package) specifiers are
 * skipped — they are external and never appear in the rendered map.
 */
function boundedRenderInputs(
  renderedFiles: Map<string, string>,
  dirtyModulePaths: string[]
): Map<string, string> {
  const norm = (p: string) => normalizeFileName(p);
  const byNorm = new Map<string, string>();
  for (const [abs, text] of renderedFiles) byNorm.set(norm(abs), text);

  const wanted = new Set<string>(dirtyModulePaths.map(norm));
  for (const dirty of dirtyModulePaths) {
    const dirtyNorm = norm(dirty);
    const text = byNorm.get(dirtyNorm);
    if (!text) continue;
    const dir = path.dirname(dirtyNorm);
    for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (!spec.startsWith(".")) continue; // bare/package specifier — external, skip
      const resolved = resolveRelativeToRenderedKey(dir, spec, byNorm);
      if (resolved !== undefined) wanted.add(resolved);
    }
  }

  const out = new Map<string, string>();
  for (const [normKey, text] of byNorm) {
    if (wanted.has(normKey)) out.set(normKey, text);
  }
  return out;
}

/**
 * Resolve a relative import specifier `spec` (starting with `.`) against
 * `dir` (the directory of the importing module, already normalized) into a
 * key that exists in `renderedKeys`. Probes the candidate base with common
 * TypeScript extensions. Returns the normalized key on a hit, undefined on miss.
 * Used by both boundedRenderInputs and could be reused by resolveModuleNames.
 */
function resolveRelativeToRenderedKey(
  dir: string,
  spec: string,
  renderedKeys: Map<string, string>
): string | undefined {
  const specBase = spec.replace(/\.(ts|tsx|js|mjs)$/, "");
  const candidateBase = normalizeFileName(path.join(dir, specBase));
  for (const ext of ["", ".ts", ".tsx", ".js", ".mjs"]) {
    const candidate = candidateBase + ext;
    if (renderedKeys.has(candidate)) return candidate;
  }
  // Barrel directory: try index files
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
    const candidate = normalizeFileName(path.join(candidateBase, "index" + ext));
    if (renderedKeys.has(candidate)) return candidate;
  }
  return undefined;
}

export function commit(db: Db, tx: TxHandle): CommitResult {
  const diagnostics = validate(db, tx);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // Snapshot the materialization plan BEFORE materializeStatementPayloads
  // clears overlay.textSpanMutations.
  const plan = planMaterialization(db, getOverlay(tx));
  const { renderedFiles } = renderPendingModules(db, tx);
  const renderedByPath = boundedRenderInputs(renderedFiles, plan.dirtyModulePaths);
  const options = loadCompilerOptions([...renderedFiles.keys()]);

  // Single transaction so a throw mid-materialization rolls back payloads,
  // node/identifier changes, edges, and the op-log together (no partial state).
  const finalize = db.transaction(() => {
    materializeStatementPayloads(db, tx);

    if (!isNoop(plan)) {
      // Collect old identifier IDs for re-derived statements BEFORE they are
      // deleted by reDeriveChangedStatements. These IDs may be re-used for
      // different identifiers after re-derivation (DFS indices shift when new
      // identifiers are added), so commitWithoutValidate must not apply stale
      // mutations to them.
      const staleIdentifierIds = collectReDerivedIdentifierIds(db, plan);
      emitIdentifiersForInserted(db, tx, plan);
      reDeriveChangedStatements(db, tx, plan);
      refreshReferenceEdges(db, plan, renderedByPath, options);
      stripStaleMutations(db, tx, staleIdentifierIds);
    }

    commitWithoutValidate(db, tx);
  });
  finalize();
  return { ok: true };
}

export interface AcceptanceContext {
  corpusRoot: string;
  srcRoot: string;
  /**
   * The task's resolved behavioral fixture list (callers resolve via
   * behavioralFixturesForTask). [] => tsc-only. Never undefined here: a
   * live gate is always task-scoped (decisions.md 2026-05-16 / BG-4).
   */
  behavioralFixtures: readonly string[];
  /**
   * When true (the bench default), the gate's tsc step asserts the corpus
   * tsconfig include is src-only — a bench-isolation invariant from the
   * 1.5-R remediation phase. When false (the freeform agent default), the
   * gate respects whatever scope the project's tsconfig declares, so real
   * projects that include tests in their tsconfig still pass through.
   */
  strictSrcOnlyTscScope?: boolean;
}

export type GatedCommitResult =
  | { ok: true }
  | { ok: false; diagnostics: Diagnostic[] }
  | { ok: false; testFailures: string };

/**
 * Commit gate that finalizes only when the transaction both type-checks
 * (as commit() requires today) AND the corpus's real test suite passes.
 * A compiles-but-behaviorally-wrong change is refused with the failing
 * test output, handed back the same way type diagnostics are.
 */
export function commitWithBehavioralGate(
  db: Db,
  tx: TxHandle,
  acceptance: AcceptanceContext
): GatedCommitResult {
  // No in-process validate() here on purpose. runCorpusAcceptance below
  // spawns a real tsc against the same rendered tree (plus the corpus's
  // tests/configs), so an in-process validate first would do the same
  // type-check work twice — once as ts.createProgram and again as the
  // spawned tsc — on every commit. The spawned tsc catches everything the
  // in-process one would have caught (and more, when the corpus tsconfig
  // includes tests), so its `testFailures` text is the single failure mode.

  // Snapshot the materialization plan BEFORE materializeStatementPayloads
  // clears overlay.textSpanMutations. The overlay still has textSpanMutations
  // at this point (renderPendingModules reads them but does not clear them).
  const plan = planMaterialization(db, getOverlay(tx));

  const { renderedFiles } = renderPendingModules(db, tx);
  const renderedByPath = boundedRenderInputs(renderedFiles, plan.dirtyModulePaths);
  const options = loadCompilerOptions([...renderedFiles.keys()]);

  const renderedSrc = new Map<string, string>();
  for (const [absPath, text] of renderedFiles) {
    const rel = path
      .relative(acceptance.srcRoot, absPath)
      .replaceAll("\\", "/");
    renderedSrc.set(rel, text);
  }

  const result = runCorpusAcceptance(
    renderedSrc,
    acceptance.corpusRoot,
    acceptance.behavioralFixtures,
    { strictSrcOnlyTscScope: acceptance.strictSrcOnlyTscScope !== false }
  );
  if (!result.tscClean || !result.vitestPassed) {
    return { ok: false, testFailures: result.failureOutput };
  }

  // Single transaction so a throw mid-materialization rolls back payloads,
  // node/identifier changes, edges, and the op-log together (no partial state).
  const finalizeGated = db.transaction(() => {
    materializeStatementPayloads(db, tx);

    if (!isNoop(plan)) {
      const staleIdentifierIds = collectReDerivedIdentifierIds(db, plan);
      emitIdentifiersForInserted(db, tx, plan);
      reDeriveChangedStatements(db, tx, plan);
      refreshReferenceEdges(db, plan, renderedByPath, options);
      stripStaleMutations(db, tx, staleIdentifierIds);
    }

    commitWithoutValidate(db, tx);
  });
  finalizeGated();
  return { ok: true };
}

/**
 * Collect the current identifier IDs for all re-derived statements BEFORE
 * reDeriveChangedStatements deletes them. These IDs will be removed from
 * overlay.identifierMutations so that commitWithoutValidate does not corrupt
 * the fresh rows that re-derivation inserts (old IDs can be re-used for
 * different identifiers when the DFS index set changes after adding params).
 */
function collectReDerivedIdentifierIds(
  db: Db,
  plan: import("@strata/store").MaterializationPlan
): Set<string> {
  const ids = new Set<string>();
  const query = db.prepare(
    `SELECT id FROM nodes WHERE parent_id = ? AND kind = 'Identifier'`
  );
  for (const statementId of plan.reDerivedStatementIds) {
    for (const row of query.all(statementId) as Array<{ id: string }>) {
      ids.add(row.id);
    }
  }
  return ids;
}

/**
 * After class-1/class-2 graph materialization, old identifier rows are deleted
 * and replaced with fresh ones. commitWithoutValidate still has those old IDs
 * in overlay.identifierMutations and would overwrite the fresh rows, corrupting
 * offsets (e.g. when new params shift DFS identifier indices, old ID N now maps
 * to a different identifier). Remove the pre-collected stale IDs.
 */
function stripStaleMutations(db: Db, tx: TxHandle, staleIds: Set<string>): void {
  const overlay = getOverlay(tx);
  for (const identifierId of staleIds) {
    overlay.identifierMutations.delete(identifierId);
  }
}

function materializeStatementPayloads(db: Db, tx: TxHandle): void {
  const overlay = getOverlay(tx);
  const affectedStatementIds = new Set<string>();
  const parentQuery = db.prepare(`SELECT parent_id FROM nodes WHERE id = ?`);

  for (const identifierId of overlay.identifierMutations.keys()) {
    const row = parentQuery.get(identifierId) as
      | { parent_id: string | null }
      | undefined;
    if (row?.parent_id) {
      affectedStatementIds.add(row.parent_id);
    }
  }
  for (const statementId of overlay.textSpanMutations.keys()) {
    affectedStatementIds.add(statementId);
  }

  const updateNode = db.prepare(`UPDATE nodes SET payload = ? WHERE id = ?`);
  const flush = db.transaction(() => {
    for (const statementId of affectedStatementIds) {
      const statement = findNode(db, statementId);
      if (!statement) {
        continue;
      }

      const identifiers = listIdentifierChildren(db, statementId);
      const mutations = identifiers
        .map((identifier) => {
          const updated = overlay.identifierMutations.get(identifier.id);
          if (!updated) {
            return null;
          }
          const payload = JSON.parse(identifier.payload) as {
            text: string;
            offset: number;
          };
          return {
            identifier,
            oldText: payload.text,
            newText: updated.text,
            offset: payload.offset
          };
        })
        .filter((mutation) => mutation !== null);

      const spanEdits = overlay.textSpanMutations.get(statementId) ?? [];
      if (mutations.length === 0 && spanEdits.length === 0) {
        continue;
      }

      const rendered = renderWithSourceMap(
        {
          id: `${statementId}:module`,
          kind: "Module",
          parentId: null,
          childIndex: null,
          payload: ""
        },
        [statement, ...identifiers],
        {
          identifierMutations: overlay.identifierMutations,
          textSpanMutations: overlay.textSpanMutations
        }
      ).text;
      updateNode.run(rendered, statementId);

      const deltas = mutations
        .map((mutation) => ({
          offset: mutation.offset,
          delta: mutation.newText.length - mutation.oldText.length
        }))
        .sort((left, right) => left.offset - right.offset);
      const spanDeltas = spanEdits
        .map((edit) => ({
          start: edit.start,
          delta: edit.newText.length - (edit.end - edit.start)
        }))
        .sort((left, right) => left.start - right.start);

      for (const identifier of identifiers) {
        const payload = JSON.parse(identifier.payload) as {
          text: string;
          offset: number;
        };
        const idShift = deltas.reduce(
          (total, delta) => total + (delta.offset < payload.offset ? delta.delta : 0),
          0
        );
        const spanShift = spanDeltas.reduce(
          (total, delta) =>
            total + (delta.start <= payload.offset ? delta.delta : 0),
          0
        );
        const updatedText =
          overlay.identifierMutations.get(identifier.id)?.text ?? payload.text;
        updateNode.run(
          JSON.stringify({
            text: updatedText,
            offset: payload.offset + idShift + spanShift
          }),
          identifier.id
        );
      }
    }
  });

  flush();
  overlay.textSpanMutations.clear();
}

function mapDiagnostic(
  diagnostic: ts.Diagnostic,
  sourceMaps: Map<string, SourceMapEntry[]>
): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const code = diagnostic.code;

  if (!diagnostic.file || typeof diagnostic.start !== "number") {
    return { nodeId: null, modulePath: null, message, code };
  }

  const modulePath = normalizeFileName(diagnostic.file.fileName);
  const sourceMap = sourceMaps.get(modulePath);
  if (!sourceMap) {
    return { nodeId: null, modulePath, message, code };
  }

  const entry = sourceMapEntryAt(sourceMap, diagnostic.start);
  return {
    nodeId: entry?.nodeId ?? null,
    modulePath,
    message,
    code
  };
}

function sourceMapEntryAt(
  sourceMap: SourceMapEntry[],
  position: number
): SourceMapEntry | undefined {
  let low = 0;
  let high = sourceMap.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entry = sourceMap[mid]!;
    if (position < entry.renderedStart) {
      high = mid - 1;
    } else if (position >= entry.renderedEnd) {
      low = mid + 1;
    } else {
      return entry;
    }
  }

  return undefined;
}

function findNode(db: Db, id: string): NodeRow | undefined {
  const row = db
    .prepare(
      `SELECT id, kind, parent_id, child_index, payload
       FROM nodes
       WHERE id = ?`
    )
    .get(id);
  return row ? rowToNode(row) : undefined;
}

function listIdentifierChildren(db: Db, parentId: string): NodeRow[] {
  return db
    .prepare(
      `SELECT id, kind, parent_id, child_index, payload
       FROM nodes
       WHERE parent_id = ? AND kind = 'Identifier'
       ORDER BY id ASC`
    )
    .all(parentId)
    .map(rowToNode);
}

function loadModuleForRender(
  db: Db,
  moduleId: string
): { module: NodeRow; children: NodeRow[] } {
  const loaded = loadModule(db, moduleId);
  const children = [...loaded.children];

  for (const child of loaded.children) {
    if (child.kind !== "Identifier") {
      children.push(...listIdentifierChildren(db, child.id));
    }
  }

  return { module: loaded.module, children };
}

function rowToNode(row: unknown): NodeRow {
  const dbRow = row as {
    id: string;
    kind: string;
    parent_id: string | null;
    child_index: number | null;
    payload: string;
  };
  return {
    id: dbRow.id,
    kind: dbRow.kind,
    parentId: dbRow.parent_id,
    childIndex: dbRow.child_index,
    payload: dbRow.payload
  };
}

function loadCompilerOptions(rootNames: string[]): ts.CompilerOptions {
  const configPath = findNearestTsconfig(rootNames) ?? findTsconfigBase();
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(formatTsDiagnostic(configFile.error));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(formatTsDiagnostic).join("\n"));
  }

  return {
    ...parsed.options,
    typeRoots: resolveTypeRoots(parsed.options, configPath),
    noEmit: true,
    skipLibCheck: true
  };
}

// In-process tsc (via ts.createProgram) doesn't auto-discover @types the way
// the tsc binary does — it relies on whatever typeRoots are set in options or
// in tsconfig. When a corpus has no explicit typeRoots and its `types` list
// includes "node" (or similar), in-process validate() fails to resolve them
// unless we make typeRoots match the binary's default discovery: walk up from
// the tsconfig dir looking for node_modules/@types, plus fall back to the
// Strata repo's own @types so corpora without their own deps still type-check.
function resolveTypeRoots(
  options: ts.CompilerOptions,
  configPath: string
): string[] {
  const explicit = Array.isArray(options.typeRoots) ? [...options.typeRoots] : [];
  const candidates = new Set<string>(explicit);
  let dir = path.dirname(configPath);
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = path.join(dir, "node_modules", "@types");
    if (existsSync(candidate)) {
      candidates.add(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const repoTypes = path.join(repoRootFromHere(), "node_modules", "@types");
  if (existsSync(repoTypes)) {
    candidates.add(repoTypes);
  }
  return [...candidates];
}

function repoRootFromHere(): string {
  return path.resolve(__dirname, "../../..");
}

function findNearestTsconfig(rootNames: string[]): string | undefined {
  for (const rootName of rootNames) {
    let dir = path.dirname(rootName);
    while (true) {
      const candidate = path.join(dir, "tsconfig.json");
      if (ts.sys.fileExists(candidate)) {
        return candidate;
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return undefined;
}

function findTsconfigBase(): string {
  const starts = [process.cwd(), __dirname].filter(Boolean);
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(dir, "tsconfig.base.json");
      if (ts.sys.fileExists(candidate)) {
        return candidate;
      }
      dir = path.dirname(dir);
    }
  }
  throw new Error("Could not locate tsconfig.base.json");
}

function formatTsDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function normalizeFileName(fileName: string): string {
  return path.resolve(fileName).replaceAll("\\", "/");
}
