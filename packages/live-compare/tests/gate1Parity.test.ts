// Gate 1 of the convergence acceptance frame (iteration 6 slice A): a
// key-free, rename-only N=1 T03 flow driven through the Rust coordination
// kernel is semantically parity-checked, six ways, against the SQLite product
// arm. No model calls, no persisted SQLite (":memory:" only). See
// docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateT03TextCriteria } from "@strata-code/verify";
import { runKernelArmT03, runSqliteArm } from "../src/gate1.js";
import { ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cleanup: string[] = [];
afterAll(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

/** Deterministic, key-order-independent JSON for byte-equality assertions. */
function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, normalize((input as Record<string, unknown>)[key])])
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

/** Content digest of a rendered tree's `src/**.ts`, module by module. */
function treeDigest(treeRoot: string): string {
  const src = join(treeRoot, "src");
  const files: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push([relative(src, abs).split("\\").join("/"), readFileSync(abs, "utf8")]);
      }
    }
  };
  walk(src);
  files.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const hash = createHash("sha256");
  for (const [path, text] of files) hash.update(path).update("\0").update(text).update("\0");
  return hash.digest("hex");
}

/** The nine text-derived T03 criteria over a rendered tree's src/, keyed src-relative. */
function evaluateT03TextCriteriaOnTree(treeRoot: string) {
  const src = join(treeRoot, "src");
  const modules = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        modules.set(relative(src, abs).split("\\").join("/"), readFileSync(abs, "utf8"));
      }
    }
  };
  walk(src);
  return evaluateT03TextCriteria(modules);
}

const ALL_TRUE = {
  importRenamed: true,
  typeAnnotationRenamed: true,
  genericPromiseRenamed: true,
  namespaceImportRenamed: true,
  auditLiteralUntouched: true,
  auditLiteralOnlyRemainingUser: true,
  indexReExportRenamed: true,
  jsdocReferencesRenamed: true
};

describe("gate 1: key-free semantic parity (kernel vs SQLite product arm)", () => {
  beforeAll(() => ensureBuilt(), 600_000);

  it("produces equivalent nodes, references, rendered TS, tsc+vitest, criteria, and audit", async () => {
    const corpus = resolve(repoRoot, "examples/medium");
    const sqlite = await runSqliteArm(corpus);
    const kernel = await runKernelArmT03(corpus);
    cleanup.push(sqlite.renderedRoot, kernel.renderedRoot, kernel.directory);

    // 1 + 2: canonical node / reference byte equality (same corpus-relative
    // ingest => same IDs; Module records compared explicitly, no blanking).
    expect(canonicalJson(kernel.snapshot.nodes)).toBe(canonicalJson(sqlite.snapshot.nodes));
    expect(canonicalJson(kernel.snapshot.references)).toBe(canonicalJson(sqlite.snapshot.references));

    // 3: rendered corpus byte equality, module by module.
    expect(treeDigest(kernel.renderedRoot)).toBe(treeDigest(sqlite.renderedRoot));

    // 4: tsc --noEmit + vitest green on BOTH rendered corpora (harness check,
    // identical invocation — see runtimeTscAndVitest wiring in gate1.ts).
    const { tscAndVitestGreen } = await import("../src/gate1.js");
    expect(await tscAndVitestGreen(kernel.renderedRoot)).toBe(true);
    expect(await tscAndVitestGreen(sqlite.renderedRoot)).toBe(true);

    // 5: T03 text criteria pass on both.
    expect(evaluateT03TextCriteriaOnTree(kernel.renderedRoot)).toMatchObject(ALL_TRUE);
    expect(evaluateT03TextCriteriaOnTree(sqlite.renderedRoot)).toMatchObject(ALL_TRUE);

    // 6: normalized audit projection equality (Shared conventions) + kernel
    // superset property. `actor` differs by construction: the SQLite arm's
    // transaction actor vs the kernel clientId — both asserted non-empty and
    // the mapping recorded in the harness / report.
    expect(sqlite.audit.actor.length).toBeGreaterThan(0);
    expect(kernel.audit.actor.length).toBeGreaterThan(0);
    expect(kernel.audit).toEqual({ ...sqlite.audit, actor: kernel.audit.actor });
    expect(kernel.audit.renamedIdentifierIds).toEqual(sqlite.audit.renamedIdentifierIds);
    expect(kernel.audit.renamedIdentifierIds.length).toBeGreaterThan(0);
    for (const id of kernel.audit.renamedIdentifierIds) {
      expect(kernel.rawAffectedNodeIds).toContain(id);
    }
  }, 600_000);
});
