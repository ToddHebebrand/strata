import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  commitWithoutValidate,
  insertNodes,
  openDb,
  queuePendingOp
} from "@strata/store";
import {
  evaluateT05Criteria,
  evaluateT05TextCriteria,
  T05_TEST_KEY
} from "../src/index";

const SRC_ROOT = path.resolve("/corpus/src");
const SEED_TEST =
  'import { describe, expect, it } from "vitest";\n' +
  'import { isWithinRange } from "../src/lib/dateRange.ts";\n' +
  "\n" +
  'const d = (iso: string) => new Date(iso);\n';

function correctModules(): Map<string, string> {
  return new Map<string, string>([
    [
      "lib/dateRange.ts",
      "export function isWithinRange(date: Date, start: Date, end: Date): boolean {\n" +
        "  return date >= start && date < end;\n" +
        "}\n"
    ],
    [T05_TEST_KEY, SEED_TEST]
  ]);
}

describe("evaluateT05TextCriteria", () => {
  it("all text criteria true for a correct half-open fix with the test untouched", () => {
    const criteria = evaluateT05TextCriteria(correctModules(), SEED_TEST);
    for (const [key, value] of Object.entries(criteria)) {
      expect(value, `criterion ${key}`).toBe(true);
    }
  });

  it("fails the symmetric anti-cheat when the test file was modified", () => {
    const modules = correctModules();
    modules.set(T05_TEST_KEY, `${SEED_TEST}// weakened\n`);
    expect(evaluateT05TextCriteria(modules, SEED_TEST).testFileByteIdentical).toBe(
      false
    );
  });

  it("fails when the comparison is still closed interval", () => {
    const modules = correctModules();
    modules.set(
      "lib/dateRange.ts",
      "export function isWithinRange(date: Date, start: Date, end: Date): boolean {\n" +
        "  return date >= start && date <= end;\n" +
        "}\n"
    );
    const criteria = evaluateT05TextCriteria(modules, SEED_TEST);
    expect(criteria.comparisonIsHalfOpen).toBe(false);
    expect(criteria.noClosedIntervalRemains).toBe(false);
  });

  it("BS15-C: identical booleans across file text and rendered store text", () => {
    const fileForm = correctModules();
    const inputs = [
      {
        path: path.join(SRC_ROOT, "lib/dateRange.ts"),
        text: fileForm.get("lib/dateRange.ts")!
      }
    ];
    const batch = ingestBatch(inputs);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const tx = begin(db, "test");
    queuePendingOp(tx, {
      kind: "ReplaceBody",
      paramsJson: "{}",
      affectedNodeIdsJson: "[]",
      reasoning: null
    });
    commitWithoutValidate(db, tx);

    const substrate = evaluateT05Criteria(db, batch, SRC_ROOT, {
      commitReturnedOk: true,
      validateAfterCommitClean: true,
      txId: tx.id,
      seedTestText: SEED_TEST
    });
    expect({
      comparisonIsHalfOpen: substrate.comparisonIsHalfOpen,
      noClosedIntervalRemains: substrate.noClosedIntervalRemains,
      testFileByteIdentical: substrate.testFileByteIdentical
    }).toEqual(evaluateT05TextCriteria(fileForm, SEED_TEST));
    expect(substrate.operationRowAppended).toBe(true);
    db.close();
  });
});
