import {
  begin,
  findNodeById,
  openDb,
  rename_symbol,
  type Db
} from "@strata-code/store";
import { commit, type Diagnostic } from "@strata-code/verify";

export interface RunRenameInput {
  dbPath: string;
  declarationId: string;
  newName: string;
  actor?: string;
}

export type RunRenameResult =
  | { ok: true; txId: string }
  | { ok: false; txId: string; diagnostics: Diagnostic[] };

export function runRename(input: RunRenameInput): RunRenameResult {
  const db = openDb(input.dbPath);
  try {
    assertDeclarationExists(db, input.declarationId);
    const tx = begin(db, input.actor ?? "cli");
    rename_symbol(db, tx, input.declarationId, input.newName);
    const result = commit(db, tx);
    if (!result.ok) {
      return { ok: false, txId: tx.id, diagnostics: result.diagnostics };
    }
    return { ok: true, txId: tx.id };
  } finally {
    db.close();
  }
}

function assertDeclarationExists(db: Db, declarationId: string): void {
  const node = findNodeById(db, declarationId);
  if (!node) {
    throw new Error(`Declaration not found: ${declarationId}`);
  }
}
