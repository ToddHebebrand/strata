import path from "node:path";
import { renderWithSourceMap, type SourceMapEntry } from "@strata/render";
import {
  commitWithoutValidate,
  getOverlay,
  listModules,
  loadModule,
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

export function validate(db: Db, tx: TxHandle): Diagnostic[] {
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

  const program = ts.createProgram({
    rootNames: [...renderedFiles.keys()],
    options,
    host
  });

  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => mapDiagnostic(diagnostic, sourceMaps));
}

export function commit(db: Db, tx: TxHandle): CommitResult {
  const diagnostics = validate(db, tx);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  materializeStatementPayloads(db, tx);
  commitWithoutValidate(db, tx);
  return { ok: true };
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
    noEmit: true,
    skipLibCheck: true
  };
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
