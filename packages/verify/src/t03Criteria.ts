import path from "node:path";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

export interface T03Criteria {
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
}

/**
 * The nine text-derived T03 criteria — a PURE function of the final
 * TypeScript text of each module, keyed by POSIX path relative to the
 * corpus src/ root. Both Phase 4 configs feed this identical function:
 * the substrate renders committed store modules to text; the baseline
 * reads post-edit .ts files off its temp working tree. The scorer cannot
 * tell which produced the text. Regexes are verbatim from the original
 * evaluateT03Criteria — none rewritten.
 */
export type T03TextCriteria = Pick<
  T03Criteria,
  | "importRenamed"
  | "typeAnnotationRenamed"
  | "genericPromiseRenamed"
  | "namespaceImportRenamed"
  | "auditLiteralUntouched"
  | "auditLiteralOnlyRemainingUser"
  | "indexReExportRenamed"
  | "jsdocReferencesRenamed"
>;

export function evaluateT03TextCriteria(
  modules: Map<string, string>
): T03TextCriteria {
  const auditText = mustGet(modules, "server/audit.ts");
  const indexText = mustGet(modules, "index.ts");
  const greetText = mustGet(modules, "users/greet.ts");
  const legacyText = mustGet(modules, "users/legacy.ts");
  const listText = mustGet(modules, "users/list.ts");
  const serializerText = mustGet(modules, "users/serializer.ts");
  const repoText = mustGet(modules, "users/repo.ts");
  const userText = mustGet(modules, "types/user.ts");

  const remainingUserOccurrences = [...modules.values()]
    .flatMap((text) => text.match(/\bUser\b/g) ?? [])
    .length;
  const auditUserOccurrences = (auditText.match(/\bUser\b/g) ?? []).length;

  return {
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
      remainingUserOccurrences === auditUserOccurrences &&
      auditUserOccurrences > 0,
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
      !/@param \{User\}/.test(legacyText)
  };
}

export interface T03CriteriaInput {
  /** Result of the agent/programmatic commit: did commit return ok? */
  commitReturnedOk: boolean;
  /** Result of a post-commit re-validate on a throwaway tx: zero diagnostics? */
  validateAfterCommitClean: boolean;
  /** The tx id whose single operation row must be the RenameSymbol row. */
  renameTxId: string;
}

export interface T03Batch {
  modules: { path: string; moduleId: string }[];
}

interface OperationRow {
  tx_id: string;
  kind: string;
  params_json: string;
  affected_node_ids_json: string;
}

/**
 * Substrate post-commit scoring for T03. Builds the rendered-text Map from
 * committed store state, delegates the nine text criteria to
 * evaluateT03TextCriteria, and adds the two substrate-driven fields plus
 * the substrate-only operationRowAppended. Signature and behavior unchanged.
 */
export function evaluateT03Criteria(
  db: Db,
  batch: T03Batch,
  srcRoot: string,
  input: T03CriteriaInput
): T03Criteria & { rendered: Map<string, string> } {
  const renderedBySuffix = new Map<string, string>();
  for (const module of batch.modules) {
    renderedBySuffix.set(
      toPosix(path.relative(srcRoot, module.path)),
      renderModule(db, module.moduleId)
    );
  }

  const text = evaluateT03TextCriteria(renderedBySuffix);
  const operations = db
    .prepare(
      `SELECT tx_id, kind, params_json, affected_node_ids_json
         FROM operations`
    )
    .all() as OperationRow[];

  return withRendered({
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true,
    ...text,
    operationRowAppended: operationLogged(operations, input.renameTxId)
  }, renderedBySuffix);
}

export function emptyT03Criteria(): T03Criteria {
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

function renderModule(db: Db, moduleId: string): string {
  const loaded = loadModule(db, moduleId);
  return renderWithSourceMap(loaded.module, loaded.children).text;
}

function withRendered<T extends object>(
  criteria: T,
  rendered: Map<string, string>
): T & { rendered: Map<string, string> } {
  Object.defineProperty(criteria, "rendered", {
    value: rendered,
    enumerable: false
  });
  return criteria as T & { rendered: Map<string, string> };
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
