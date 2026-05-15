import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { renderWithSourceMap } from "@strata/render";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  loadModule,
  openDb,
  rename_symbol,
  rollback,
  type Db
} from "@strata/store";
import { commit, validate, type Diagnostic } from "@strata/verify";

export interface RunT03Input {
  corpusRoot: string;
}

export interface RunT03Result {
  commitOk: boolean;
  diagnostics?: Diagnostic[];
  wallTimeMs: number;
  criteria: {
    commitReturnedOk: boolean;
    validateAfterCommitClean: boolean;
    importRenamed: boolean;
    typeAnnotationRenamed: boolean;
    genericPromiseRenamed: boolean;
    namespaceImportRenamed: boolean;
    auditLiteralUntouched: boolean;
    auditLiteralOnlyRemainingUser: boolean;
    indexReExportRenamed: boolean;
    jsdocReferencesRenamed: boolean;
    operationRowAppended: boolean;
  };
}

interface OperationRow {
  tx_id: string;
  kind: string;
  params_json: string;
  affected_node_ids_json: string;
}

export function runT03(input: RunT03Input): RunT03Result {
  const started = performance.now();
  const srcRoot = path.join(input.corpusRoot, "src");
  const modules = collectTsFiles(srcRoot);
  const batch = ingestBatch(modules);
  const db = openDb(":memory:");

  try {
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const declarations = find_declarations(db, {
      name: "User",
      kind: "interface"
    });
    if (declarations.length !== 1) {
      throw new Error(
        `Expected exactly one InterfaceDeclaration named User; got ${declarations.length}`
      );
    }

    const tx = begin(db, "t03");
    rename_symbol(db, tx, declarations[0]!.id, "Account");
    const commitResult = commit(db, tx);
    if (!commitResult.ok) {
      return {
        commitOk: false,
        diagnostics: commitResult.diagnostics,
        wallTimeMs: elapsed(started),
        criteria: emptyCriteria()
      };
    }

    const checkTx = begin(db, "t03-check");
    const postCommitDiagnostics = validate(db, checkTx);
    rollback(db, checkTx);

    const renderedBySuffix = new Map<string, string>();
    for (const module of batch.modules) {
      renderedBySuffix.set(
        toPosix(path.relative(srcRoot, module.path)),
        renderModule(db, module.moduleId)
      );
    }

    const auditText = mustGet(renderedBySuffix, "server/audit.ts");
    const indexText = mustGet(renderedBySuffix, "index.ts");
    const greetText = mustGet(renderedBySuffix, "users/greet.ts");
    const legacyText = mustGet(renderedBySuffix, "users/legacy.ts");
    const listText = mustGet(renderedBySuffix, "users/list.ts");
    const serializerText = mustGet(renderedBySuffix, "users/serializer.ts");
    const repoText = mustGet(renderedBySuffix, "users/repo.ts");
    const userText = mustGet(renderedBySuffix, "types/user.ts");

    const remainingUserOccurrences = [...renderedBySuffix.values()]
      .flatMap((text) => text.match(/\bUser\b/g) ?? [])
      .length;
    const auditUserOccurrences = (auditText.match(/\bUser\b/g) ?? []).length;
    const operations = db
      .prepare(
        `SELECT tx_id, kind, params_json, affected_node_ids_json
         FROM operations`
      )
      .all() as OperationRow[];

    const criteria: RunT03Result["criteria"] = {
      commitReturnedOk: commitResult.ok === true,
      validateAfterCommitClean: postCommitDiagnostics.length === 0,
      importRenamed:
        /import type \{\s*Account\s*\} from "\.\.\/types\/user\.ts";/.test(
          greetText
        ),
      typeAnnotationRenamed:
        /export function greet\(user: Account\): string/.test(greetText) &&
        /export interface Account\b/.test(userText) &&
        /save\(user: Account\): Promise<void>;/.test(repoText),
      genericPromiseRenamed:
        /Promise<Account\[\]>/.test(listText) &&
        !/Promise<User\[\]>/.test(listText),
      namespaceImportRenamed:
        /import type \* as UserTypes from "\.\.\/types\/user\.ts";/.test(
          serializerText
        ) && /user: UserTypes\.Account/.test(serializerText),
      auditLiteralUntouched:
        /"User"/.test(auditText) && /kind: "User"/.test(auditText),
      auditLiteralOnlyRemainingUser:
        remainingUserOccurrences === auditUserOccurrences && auditUserOccurrences > 0,
      indexReExportRenamed:
        /export type \{\s*Account\s*\} from "\.\/types\/user\.ts";/.test(
          indexText
        ) &&
        !/export type \{\s*User\s*\} from "\.\/types\/user\.ts";/.test(
          indexText
        ),
      jsdocReferencesRenamed:
        /@param \{Account\} user/.test(greetText) &&
        /@param \{Account\} u/.test(legacyText) &&
        !/@param \{User\}/.test(greetText) &&
        !/@param \{User\}/.test(legacyText),
      operationRowAppended: operationLogged(operations, tx.id)
    };

    return {
      commitOk: true,
      wallTimeMs: elapsed(started),
      criteria
    };
  } finally {
    db.close();
  }
}

function renderModule(db: Db, moduleId: string): string {
  const loaded = loadModule(db, moduleId);
  return renderWithSourceMap(loaded.module, loaded.children).text;
}

function operationLogged(operations: OperationRow[], txId: string): boolean {
  if (operations.length !== 1) {
    return false;
  }

  const operation = operations[0]!;
  if (operation.tx_id !== txId || operation.kind !== "RenameSymbol") {
    return false;
  }

  const params = JSON.parse(operation.params_json) as {
    old_name?: string;
    new_name?: string;
  };
  const affected = JSON.parse(operation.affected_node_ids_json) as unknown[];
  return (
    params.old_name === "User" &&
    params.new_name === "Account" &&
    affected.length > 1
  );
}

function emptyCriteria(): RunT03Result["criteria"] {
  return {
    commitReturnedOk: false,
    validateAfterCommitClean: false,
    importRenamed: false,
    typeAnnotationRenamed: false,
    genericPromiseRenamed: false,
    namespaceImportRenamed: false,
    auditLiteralUntouched: false,
    auditLiteralOnlyRemainingUser: false,
    indexReExportRenamed: false,
    jsdocReferencesRenamed: false,
    operationRowAppended: false
  };
}

function collectTsFiles(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const absolutePath = path.join(dir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        out.push({
          path: absolutePath,
          text: readFileSync(absolutePath, "utf8")
        });
      }
    }
  }

  walk(rootDir);
  return out;
}

function mustGet(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing rendered module: ${key}`);
  }
  return value;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}
