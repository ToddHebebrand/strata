import path from "node:path";
import { describe, expect, it } from "vitest";
import { runT03 } from "../src/commands/t03";

describe("T03 acceptance", () => {
  it("renames User to Account through all reference positions and leaves the audit literal untouched", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");

    const result = runT03({ corpusRoot });

    expect(result.commitOk, JSON.stringify(result.diagnostics ?? [], null, 2)).toBe(
      true
    );
    expect(result.criteria.commitReturnedOk).toBe(true);
    expect(result.criteria.validateAfterCommitClean).toBe(true);
    expect(result.criteria.importRenamed).toBe(true);
    expect(result.criteria.typeAnnotationRenamed).toBe(true);
    expect(result.criteria.genericPromiseRenamed).toBe(true);
    expect(result.criteria.namespaceImportRenamed).toBe(true);
    expect(result.criteria.auditLiteralUntouched).toBe(true);
    expect(result.criteria.auditLiteralOnlyRemainingUser).toBe(true);
    expect(result.criteria.indexReExportRenamed).toBe(true);
    expect(result.criteria.jsdocReferencesRenamed).toBe(true);
    expect(result.criteria.operationRowAppended).toBe(true);
  });
});
