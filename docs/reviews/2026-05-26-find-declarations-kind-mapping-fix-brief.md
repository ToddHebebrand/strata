# Independent review brief — 2-line `find_declarations` kind-mapping bug fix

**Audience:** an independent reviewer model (Codex CLI, `gpt-5.5`, reasoning `xhigh`, read-only, repo-grounded). You are being asked to review a small canonical bug fix that is empirically load-bearing per the 2026-05-26 lab arc (LAB-NOTES.md, last entries). Prior reviews caught decision-grade issues; the same discipline applies even to small fixes.

## How to use this brief

- Self-contained, but the authoritative sources are `CLAUDE.md`, `decisions.md`, and `packages/lab/LAB-NOTES.md` (the 2026-05-26 entries especially).
- **Verify every pivotal empirical claim against the actual code before accepting.** The pivotal code is `packages/store/src/queries.ts`, `packages/store/src/rename.ts`, `packages/ingest/src/index.ts` (look at how it emits `FirstStatement` vs `VariableStatement`), and `packages/lab/src/experiments/equippedToolServer.ts` (the lab-side workaround that mirrors what this fix would do canonically).
- The fix is 2 lines. The brief's job is to surface blast-radius concerns and tests we should add.

## The bug

`packages/store/src/queries.ts:17-23`:
```ts
const KIND_TO_STATEMENT_KIND: Record<DeclarationKind, string> = {
  interface: "InterfaceDeclaration",
  "type-alias": "TypeAliasDeclaration",
  class: "ClassDeclaration",
  function: "FunctionDeclaration",
  variable: "VariableStatement"  // ← BUG
};
```

`packages/store/src/rename.ts:12-18`:
```ts
const DECLARATION_KINDS = new Set([
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
  "ClassDeclaration",
  "FunctionDeclaration",
  "VariableStatement"  // ← BUG (consistent mismatch)
]);
```

Ingest emits `export const X` as kind `"FirstStatement"` because:
```js
ts.SyntaxKind.FirstStatement === ts.SyntaxKind.VariableStatement  // both === 244
ts.SyntaxKind[244] === "FirstStatement"  // alias wins reverse-lookup race
```

So `find_declarations({kind:"variable"})` builds SQL filter `kind = 'VariableStatement'` which never matches the data. `kind = 'FirstStatement'` would.

## The proposed fix (2 lines)

```diff
-  variable: "VariableStatement"
+  variable: "FirstStatement"
```

```diff
-  "VariableStatement"
+  "FirstStatement"
```

## Why this matters now

Documented as a latent issue in `packages/lab/LAB-NOTES.md` 2026-05-17 CORRECTION entry. The 2026-05-26 arc (same file, later entries) measured the bug's *operational* impact:

- **Sonnet:** fishes by bare-name queries anyway, so the bug is silent (sonnet never engages the kind filter).
- **Opus:** when given a corpus-map prefix that says `exports const ZONE`, opus targets `find_declarations({name:"ZONE", kind:"variable"})`, gets `[]`, then **exhaustively cycles through every other kind** (`type-alias`, `interface`, `class`) before giving up. This induces a +250% empty-query regression vs no-preload.
- **2x2 measurement (lab-layer bug-fix wrapper):** with the bug fixed at the tool-handler layer (via `buildEquippedToolServer` which already mirrors this fix), opus + preload drops empty queries from 7 → 0 and total calls from 38 → 35. The same configuration with sonnet drops from 5 → 0 empty queries and 44 → 34 total calls. **Preload + bug-fix is the only configuration with 0 empty queries for both models.**

Without the bug fix, any downstream improvement that steers the agent toward kind-filtered queries (corpus-preload, richer system prompts, structured tool descriptions) is opus-regressive on tasks involving const declarations. The fix is the gating prerequisite for cross-model agent improvements.

## What we want from you

1. **Verify the bug.** Run `node -e "const ts = require('typescript'); console.log(ts.SyntaxKind.FirstStatement === ts.SyntaxKind.VariableStatement, ts.SyntaxKind[244])"` and confirm `true FirstStatement`. Verify `packages/ingest/src/index.ts` and `packages/store/src/queries.ts` say what this brief claims.

2. **Blast-radius analysis.** Search canonical code for every reference to `"VariableStatement"` (literal string) and reason about whether each one is correct as-is or would also need to swap to `"FirstStatement"`. The two we found:
   - `packages/store/src/queries.ts:22` (the bug; proposed fix swaps it).
   - `packages/store/src/rename.ts:17` (same bug; proposed fix swaps it consistently).
   - Are there others we missed? Especially in `packages/verify/src/`, `packages/render/src/`, and the bench/agent test files.

3. **TypeScript SyntaxKind alias concerns.** `FirstStatement` is an alias enum value (244) that TypeScript happens to expose as the "primary" name via reverse lookup. Is it stable across TypeScript versions? Could a future TS version break this fix by changing the alias-resolution order? If so, the long-term fix is probably to normalize at ingest time (always emit "VariableStatement", never "FirstStatement"), not to chase the alias name in queries. Worth flagging.

4. **Test gap.** Why didn't existing tests catch this? Likely the unit tests for `find_declarations` test functions/interfaces/classes (which work) and don't test variables-via-kind-filter against a corpus that has const decls. Recommend the smallest test addition that would have caught this: probably a query test in `packages/store/tests/queries.test.ts` (if it exists) for `find_declarations({kind:"variable"})` returning at least one `export const` decl.

5. **Rename consequence.** `rename.ts:17` lives in `DECLARATION_KINDS` — a set used to validate that a rename target is a renameable declaration. After the fix, `export const X` becomes renameable. Is `rename_symbol` actually safe on const decls? It currently isn't tested for them; this fix would silently enable a code path that may have its own bugs. Recommend either (a) explicitly test rename on a const decl as part of the fix, or (b) keep `rename.ts` unchanged for now and fix only `queries.ts` (with a comment explaining the asymmetry — rename only knows the four declaration kinds it's been tested on).

6. **Final ask.** Do you ENDORSE the 2-line fix as proposed? Endorse the asymmetric variant (queries.ts only)? Or recommend a deeper fix (normalize at ingest time)? Be specific.

## Constraints

- Read-only. No code changes, no test runs, no commands beyond reading.
- Verify pivotal claims against actual code before accepting.
- Final report under 600 words. Front-load: endorse / asymmetric / deeper-fix.
