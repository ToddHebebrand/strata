# Item B-1 — Bounded Discovery Surface Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2, post-review — READY TO EXECUTE. Independent methodology
review completed on v1 (verdict PROCEED-WITH-CORRECTIONS): brief at
`docs/superpowers/specs/2026-08-01-item-b1-plan-review-brief.md`, Codex
gpt-5.6-sol xhigh read-only output archived with in-session verification
notes at `2026-08-01-item-b1-plan-review-codex.md`. Governing spec:
`docs/superpowers/specs/2026-07-31-item-b-design.md` (slice B-1).

**Review corrections applied in v2** (all eight findings; see the archive
for evidence):
1. (Blocker) Task 1 now updates the session's `Declarations` constructor
   with a truthful `has_more: false` so the crate compiles; Task 3 wires
   the real value. Task 4 adds only the three new handlers.
2. (Major) The path projector validates raw slash-separated string
   segments BEFORE any `Path` construction — `Path::components()`
   normalizes `.` and repeated separators and must not be the validator.
3. (Major) Every claimed red step is now genuinely red: Task 1 lands types
   before validators so validator tests fail honestly; Task 2 declares
   `mod paths` with a bailing stub before its red run; Task 4's red run
   uses a shared `discovery_` test-name prefix covering all six tests;
   Task 7 is relabeled an acceptance gate (not failing-first TDD).
4. (Major) Task 5 adds a repo-wide textual call sweep (the package
   tsconfig compiles only `src`; positional `findDeclarations` calls live
   in tests too) and runs the FULL live-compare suite.
5. (Major) The frozen-manifest guard no longer trusts the self-referential
   check alone: the bootstrap gate pins the approved registration digest
   LITERAL, and no commit in this plan stages
   `packages/live-compare/src/tasks.ts`.
6. (Minor) Bootstrap gate: audit-count assertion downgraded to
   corroboration; every pagination walk asserts ONE generation throughout;
   reference comparison is exact set equality (valid under the subtree
   semantics below).
7. (Minor) Export-detection parity tests added (comments, unterminated
   comments, boundary-free `export` prefix).
8. (Minor) Task 1's commit stages the live-compare test tree it edits.

**Review-resolved decisions:** `find_declarations` keeps a FIXED 64-item
page (no client `limit` — spec-governed); `limit` is REQUIRED on the three
new requests (the `read_events` precedent); NO second manifest-driven
digest-equivalence service run in the bootstrap gate (tests mutation
parity, not discovery — scope creep).

**`get_references` semantics (documented interpretation, found during
claim verification — the review missed it):** ingest references ALWAYS
target the declaration's name-identifier child, never the statement node
(`packages/store/src/resolveReferences.ts:61-63`), so a literal
per-node `references_to(nodeId)` would return an empty list for every
discovered declaration and the spec's own zero-ID gate flow
(`list_modules → list_module_declarations → get_references → publish`)
would be unsatisfiable. `get_references { nodeId }` therefore returns the
references whose TARGET lies in the subtree rooted at `nodeId` and whose
SOURCE lies outside that subtree — exactly how the sealed manifest
computes a target's `incomingReferenceIds`
(`packages/live-compare/src/tasks.ts:387-390`). For a leaf node this
degenerates to direct incoming references, so it still serves as the
pageable replacement for `inspect_nodes`' relationships-over-bound
failure. Flag this interpretation explicitly in the closing decisions.md
entry.

**Goal:** Give coordination clients a bounded, paginated, ID-free discovery
surface — `list_modules`, `list_module_declarations`, scoped/paged
`find_declarations`, `get_references` — so an agent can resolve a T03-class
target from zero pre-supplied node IDs, with a fail-closed corpus-relative
path projection for module display paths.

**Architecture:** Four new/extended read-only actions flow through the
existing strict dual-language wire contract (Rust
`strata_kernel_service/protocol.rs` + TS `live-compare/src/protocol.ts` +
shared golden fixtures), new query methods on `Kernel` (no snapshot
materialization beyond what `find_declarations` already does), a pure
path-projection function in the service binary, client wrappers and agent
tools in `live-compare`, and a deterministic key-free zero-ID
discovery-bootstrap gate that runs beside the sealed Phase-6 manifests.

**Tech Stack:** Rust (strata-kernel crate + service bin, serde, anyhow),
TypeScript (zod v3 wire schemas in live-compare, zod/v4 tool schemas,
Vitest), shared JSON golden fixtures, pnpm scripts for gate wiring.

## Global Constraints

- **Collection contract (spec, verbatim):** every collection response carries
  `graphGeneration`, deterministic ID ordering, an explicit cursor +
  `hasMore` continuation (no more fail-past-the-cap), and documented bounds.
  Clients restart pagination when the generation changes.
- **Bounds:** `list_modules` limit 1..=64; `list_module_declarations` limit
  1..=64; `get_references` limit 1..=256; `find_declarations` page fixed at
  64 (`MAX_DECLARATION_MATCHES`); module display path ≤ 512 UTF-8 bytes.
  `limit` is REQUIRED on the three new requests.
- **Path projection (spec, verbatim):** Module payloads may be physical
  ABSOLUTE paths; the endpoint derives a corpus-relative POSIX display path
  validated against the configured corpus root and FAILS CLOSED on escape or
  non-representable payloads — the raw payload is never exposed (not in the
  response, not in error messages); `inspect_nodes`' Module-payload blanking
  is unchanged; `moduleId` remains the sole authority and mutation key. One
  non-projectable module fails the WHOLE `list_modules` request (a skipped
  module would silently hide part of the discovery surface); the daemon
  itself stays up and other requests keep working.
- **`find_declarations` defaults unchanged:** global exact-name semantics
  stay; only the >64-match `bail!` is replaced by cursor + `hasMore`.
- **`inspect_nodes` is NOT modified.** Its relationships-over-bound failure
  stays; `get_references` is the pageable replacement (review Major, Q1).
- **Sealed Phase-6 manifests untouched:** `packages/live-compare/src/tasks.ts`
  is not edited AND is never staged by any commit in this plan;
  `APPROVED_TASK_REGISTRATION_DIGEST`
  (`628bd6dabedc2e99b09375bb3b05da1663e6c25f86933113fd64497c1a140233`) is
  pinned as a LITERAL inside the bootstrap gate. The gate runs BESIDE the
  sealed manifests and uses the manifest for assertions only.
- **Protocol version stays 1.** Both wire parsers are strict and live in this
  repo, always deployed in lockstep; field additions within v1 follow the
  `renamedSymbols` precedent. All shared golden fixtures are updated in the
  same task as both parsers.
- **Deferred, recorded (spec):** `semantic_search`, general file reads,
  registered-fixture reader (B-2). Do not implement any of them.
- **Deterministic, key-free gates only.** No keyed/live-model spend anywhere
  in this slice. `pnpm -r test` and the kernel chain need no key.
- **Environment:** prefix all test commands with
  `PATH=/opt/homebrew/bin:$PATH` (native modules are built against Homebrew
  node v26; without it kernel-bridge paths fail with redacted
  `request_failed`). Never use `pnpm --filter <pkg> test -- <name>` — the
  `--` silently runs the whole suite; write `pnpm --filter <pkg> test <name>`.
- **Green claims for the kernel require the full chain**
  (`pnpm kernel:full-key-free:test`), not bare `cargo test`.

## File Structure

- `crates/strata-kernel/src/kernel.rs` — new query methods (`list_modules`,
  `list_module_declarations`, extended `find_declarations`,
  `incoming_references`), page-bound constants, exported-payload helper.
- `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs` — new
  request/response variants + validators.
- `crates/strata-kernel/src/bin/strata_kernel_service/paths.rs` — NEW: pure
  fail-closed module path projection + unit tests.
- `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` — `mod
  paths;`, thread `--corpus-root` into `ServiceConfig` (flag already
  exists; no argv change).
- `crates/strata-kernel/src/bin/strata_kernel_service/session.rs` — read
  handlers, canonical corpus root, journal-replay bail arm.
- `crates/strata-kernel/tests/local_service.rs` — daemon integration tests
  (absolute-payload projection, pagination, fail-closed escape).
- `crates/strata-kernel/tests/discovery_queries.rs` — NEW: kernel query
  unit/property tests over hand-built snapshots.
- `packages/live-compare/src/protocol.ts` — TS wire schemas.
- `packages/live-compare/tests/fixtures/protocol-v1/{accepted,rejected}.json`
  — shared golden fixture cases.
- `packages/live-compare/src/client.ts` — wrappers + read-only action list.
- `packages/live-compare/src/tools.ts` — agent tool surface.
- `packages/live-compare/tests/discoveryBootstrap.test.ts` — NEW: zero-ID
  discovery-bootstrap acceptance gate.
- `package.json` (repo root) — `kernel:discovery:test` script, appended to
  `kernel:full-key-free:test`.
- `decisions.md`, `docs/product-roadmap.md` — closing entries.

Wire-name and Rust-name summary (used consistently by every task):

| Wire action | Rust variant | Kernel method |
|---|---|---|
| `list_modules` | `RequestAction::ListModules` | `Kernel::list_modules` |
| `list_module_declarations` | `RequestAction::ListModuleDeclarations` | `Kernel::list_module_declarations` |
| `find_declarations` (+`moduleId?`, `afterNodeId?`) | `RequestAction::FindDeclarations` | `Kernel::find_declarations` |
| `get_references` | `RequestAction::GetReferences` | `Kernel::incoming_references` |

| Wire result | Rust variant |
|---|---|
| `modules` | `ResponseResult::Modules { graph_generation, modules, has_more }` |
| `module_declarations` | `ResponseResult::ModuleDeclarations { graph_generation, declarations, has_more }` |
| `declarations` (+`hasMore`) | `ResponseResult::Declarations { graph_generation, declarations, has_more }` |
| `references` | `ResponseResult::References { graph_generation, references, has_more }` |

Cursor semantics (identical for all four): items are ordered by strictly
ascending ID (lexicographic byte order — `BTreeMap<String>` iteration
order); the cursor value is the last ID of the previous page; a page
contains only items with ID strictly greater than the cursor; the cursor
need not name an existing node (it is only a bound); `hasMore` is true iff
at least one further item exists beyond the returned page at the stamped
generation. For `get_references` the item ID is `fromNodeId`, which is
unique per reference because `references_from` keys references by their
from-node — this holds for subtree aggregation too, since a single from
node has at most one outgoing reference in the whole graph.

---

### Task 1: Dual-language wire contract + shared golden fixtures

This task is deliberately one unit: the Rust parser, the TS parser, and the
shared golden fixtures are mutually strict (both sides
`deny_unknown_fields`/`.strict()` and the fixtures are round-tripped by both
test suites), so they can only change in lockstep. A reviewer gates the wire
contract as a whole. TDD order inside the task: types land first (Step 2,
compile-only), validator tests go red (Steps 3–4), validators turn them
green (Step 5).

**Files:**
- Modify: `crates/strata-kernel/src/kernel.rs` (constants only, ~line 126)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
  (journal-replay bail arm ~line 649 + `Declarations` constructor ~line 826)
- Modify: `packages/live-compare/src/protocol.ts`
- Modify: `packages/live-compare/tests/fixtures/protocol-v1/accepted.json`
- Modify: `packages/live-compare/tests/fixtures/protocol-v1/rejected.json`
- Modify: `packages/live-compare/tests/protocol.test.ts` and any test that
  hand-builds a `declarations` result (known: `tests/tools.test.ts:24-27`
  fake client)
- Test: `crates/strata-kernel/tests/local_service.rs` (existing
  fixture-driven round-trip test picks up new cases automatically)

**Interfaces:**
- Produces (Rust, in `strata_kernel` lib, next to
  `MAX_DECLARATION_MATCHES`, re-exported the same way):
  ```rust
  pub const MAX_MODULE_PAGE_ITEMS: usize = 64;
  pub const MAX_MODULE_DECLARATION_PAGE_ITEMS: usize = 64;
  pub const MAX_REFERENCE_PAGE_ITEMS: usize = 256;
  ```
- Produces (Rust, protocol.rs): the request/response variants and payload
  structs below, all `rename_all = "camelCase"`, `deny_unknown_fields`,
  plus `pub const MAX_MODULE_PATH_BYTES: usize = 512;`.
- Produces (TS, protocol.ts): matching zod schemas; `MUTATING_ACTIONS`
  unchanged (new actions are read-only by omission, which is correct — the
  `idempotencyKey` superRefine then enforces key-free reads for them).
- Consumed by: Task 3 (kernel wiring), Task 4 (session handlers), Task 5
  (client), Task 6 (tools).

- [ ] **Step 1: Add the three page constants to `strata_kernel`** beside
  `MAX_DECLARATION_MATCHES` in `kernel.rs` (match `lib.rs`'s existing
  re-export style for `MAX_DECLARATION_MATCHES`).

- [ ] **Step 2: Land the wire TYPES (no validation yet).** Extend
  `RequestAction`:

```rust
    FindDeclarations {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        module_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        after_node_id: Option<String>,
    },
    ListModules {
        #[serde(skip_serializing_if = "Option::is_none")]
        after_module_id: Option<String>,
        limit: u32,
    },
    ListModuleDeclarations {
        module_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        after_node_id: Option<String>,
        limit: u32,
    },
    GetReferences {
        node_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        after_reference_key: Option<String>,
        limit: u32,
    },
```

  Extend `ResponseResult`:

```rust
    Declarations {
        graph_generation: WireU64,
        declarations: Vec<DeclarationSummary>,
        has_more: bool,
    },
    Modules {
        graph_generation: WireU64,
        modules: Vec<ModuleSummary>,
        has_more: bool,
    },
    ModuleDeclarations {
        graph_generation: WireU64,
        declarations: Vec<ModuleDeclarationSummary>,
        has_more: bool,
    },
    References {
        graph_generation: WireU64,
        references: Vec<ReferenceSummary>,
        has_more: bool,
    },
```

```rust
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ModuleSummary {
    pub(super) module_id: String,
    pub(super) path: String,
    pub(super) declaration_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ModuleDeclarationSummary {
    pub(super) node_id: String,
    pub(super) name: Option<String>,
    pub(super) kind: String,
    pub(super) exported: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReferenceSummary {
    pub(super) from_node_id: String,
    pub(super) kind: String,
    pub(super) module_id: String,
}
```

  (`ModuleDeclarationSummary.name` serializes as `null` when `None` — no
  `skip_serializing_if` — because the TS schema requires the key with
  `.nullable()`.)

  Update `RequestAction::name()` (`list_modules`,
  `list_module_declarations`, `get_references` — this is also the
  audit/metrics vocabulary), leave `is_mutating()` untouched, give the new
  arms EMPTY validation for now (add them to `validate()` matching but
  only validating nothing — `{}` bodies), and add stub `Ok(())`-shaped
  validation arms for the new `ResponseResult` variants (bounds NOT yet
  enforced).

  Make the crate compile:
  - session.rs journal-replay bail arm gains the three new variants:

```rust
            RequestAction::Hello { .. }
            | RequestAction::InspectNodes { .. }
            | RequestAction::FindDeclarations { .. }
            | RequestAction::ListModules { .. }
            | RequestAction::ListModuleDeclarations { .. }
            | RequestAction::GetReferences { .. }
            | RequestAction::ReadEvents { .. }
            | RequestAction::ReadOperation { .. } => {
                bail!("read-only action cannot be in the mutation journal")
            }
```

  - session.rs `execute_read`'s `FindDeclarations` arm destructures the
    new fields with `..` and, because the kernel still bails past 64
    matches in this task, constructs the response with a TRUTHFUL
    `has_more: false` (a successful pre-B-1 response can never have a
    further page):

```rust
            RequestAction::FindDeclarations { name, kind, .. } => {
                let (generation, matches) =
                    self.kernel.find_declarations(name, kind.as_deref())?;
                Ok(ResponseResult::Declarations {
                    graph_generation: WireU64::new(generation),
                    declarations: matches
                        .into_iter()
                        .map(|declaration| DeclarationSummary {
                            node_id: declaration.node_id,
                            kind: declaration.kind,
                            name: declaration.name,
                            module_id: declaration.module_id,
                        })
                        .collect(),
                    // Kernel still fails past MAX_DECLARATION_MATCHES, so a
                    // successful response never has a further page. Task 3
                    // replaces this with the kernel-reported value.
                    has_more: false,
                })
            }
```

    The three brand-new actions fall through `execute_read`'s existing
    `_ => bail!("mutating action cannot use the read path")` arm until
    Task 4; no test exercises them before then.

  Run: `cargo build -p strata-kernel` — expected: compiles.

- [ ] **Step 3: Write the Rust validator tests (RED).** In protocol.rs's
  `#[cfg(test)] mod tests`:

```rust
#[test]
fn list_modules_request_rejects_zero_and_over_bound_limits() {
    for limit in [0u32, 65] {
        let action = RequestAction::ListModules { after_module_id: None, limit };
        assert!(action.validate().is_err(), "limit {limit} must be rejected");
    }
    let action = RequestAction::ListModules { after_module_id: None, limit: 64 };
    action.validate().expect("limit 64 must validate");
}

#[test]
fn module_path_validator_fails_closed() {
    for bad in ["", "/abs/path.ts", "src\\win.ts", "src/../escape.ts", "src//x.ts", "./src/x.ts", "src/./x.ts"] {
        assert!(validate_module_path(bad).is_err(), "{bad:?} must be rejected");
    }
    validate_module_path("src/types/user.ts").expect("relative POSIX path must validate");
}

#[test]
fn module_declarations_response_rejects_unknown_kind() {
    let result = ResponseResult::ModuleDeclarations {
        graph_generation: WireU64::new(1),
        declarations: vec![ModuleDeclarationSummary {
            node_id: "n1".into(),
            name: None,
            kind: "EnumDeclaration".into(),
            exported: false,
        }],
        has_more: false,
    };
    assert!(result.validate().is_err());
}

#[test]
fn get_references_request_bounds_limit_at_256() {
    let ok = RequestAction::GetReferences { node_id: "n".into(), after_reference_key: None, limit: 256 };
    ok.validate().expect("limit 256 must validate");
    let over = RequestAction::GetReferences { node_id: "n".into(), after_reference_key: None, limit: 257 };
    assert!(over.validate().is_err());
}

/// Pins the frame-headroom assumption from the plan review: a maximal
/// modules page (64 items, 512-byte paths) serializes well inside
/// MAX_RESPONSE_FRAME_BYTES.
#[test]
fn maximal_modules_page_fits_the_response_frame() {
    let response = LocalServiceResponse::success(
        "request:max-page",
        ResponseResult::Modules {
            graph_generation: WireU64::new(1),
            modules: (0..64)
                .map(|index| ModuleSummary {
                    module_id: format!("{index:016x}"),
                    path: format!("src/{}.ts", "a".repeat(MAX_MODULE_PATH_BYTES - 7)),
                    declaration_count: u32::MAX,
                })
                .collect(),
            has_more: true,
        },
    );
    serialize_response_frame(&response).expect("maximal modules page must fit the frame");
}
```

- [ ] **Step 4: Run to verify genuine failure** —
  `cargo test -p strata-kernel --bin strata-kernel-service` — expected:
  FAIL (`validate_module_path` undefined; limit/kind validators absent —
  the first two tests fail to compile or fail assertions; iterate until
  the failures are exactly the missing-validator ones).

- [ ] **Step 5: Implement validation.** Add:

```rust
pub const MAX_MODULE_PATH_BYTES: usize = 512;

/// Persisted top-level statement kinds the discovery surface counts and
/// lists — the same set `PRODUCT_KINDS` maps to in kernel.rs, mirrored from
/// `packages/store/src/discovery.ts` DISCOVERY_KINDS.
const DISCOVERY_STATEMENT_KINDS: [&str; 5] = [
    "InterfaceDeclaration",
    "TypeAliasDeclaration",
    "ClassDeclaration",
    "FunctionDeclaration",
    "FirstStatement",
];

fn validate_page_limit(limit: u32, max: usize, action: &str) -> Result<()> {
    if limit == 0 || limit as usize > max {
        bail!("{action} limit is outside the supported bound");
    }
    Ok(())
}

fn validate_module_path(value: &str) -> Result<()> {
    if value.is_empty() {
        bail!("module path must not be empty");
    }
    if value.len() > MAX_MODULE_PATH_BYTES {
        bail!("module path exceeds {MAX_MODULE_PATH_BYTES} UTF-8 bytes");
    }
    if value.starts_with('/') || value.contains('\\') {
        bail!("module path must be corpus-relative POSIX");
    }
    if value
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        bail!("module path contains an invalid segment");
    }
    Ok(())
}
```

  Fill the request `validate()` arms:

```rust
    Self::ListModules { after_module_id, limit } => {
        validate_optional_id(after_module_id, "afterModuleId")?;
        validate_page_limit(*limit, MAX_MODULE_PAGE_ITEMS, "list_modules")?;
    }
    Self::ListModuleDeclarations { module_id, after_node_id, limit } => {
        validate_string(module_id, MAX_ID_BYTES, false, "moduleId")?;
        validate_optional_id(after_node_id, "afterNodeId")?;
        validate_page_limit(*limit, MAX_MODULE_DECLARATION_PAGE_ITEMS, "list_module_declarations")?;
    }
    Self::GetReferences { node_id, after_reference_key, limit } => {
        validate_string(node_id, MAX_ID_BYTES, false, "nodeId")?;
        validate_optional_id(after_reference_key, "afterReferenceKey")?;
        validate_page_limit(*limit, MAX_REFERENCE_PAGE_ITEMS, "get_references")?;
    }
```

  and extend the `FindDeclarations` arm with
  `validate_optional_id(module_id, "moduleId")?` and
  `validate_optional_id(after_node_id, "afterNodeId")?`.

  Fill the response `validate()` arms:
  - `Declarations` — unchanged bounds (`MAX_DECLARATION_MATCHES`);
    `has_more` needs no validation.
  - `Modules` — `bounded_items(modules.len(), 0, MAX_MODULE_PAGE_ITEMS,
    "modules")`; per item `validate_string(module_id, MAX_ID_BYTES,
    false, "moduleId")` and `validate_module_path(path)`.
  - `ModuleDeclarations` — `bounded_items(…, 0,
    MAX_MODULE_DECLARATION_PAGE_ITEMS, "declarations")`; per item
    `validate_string(node_id, …)`, `validate_optional_id(name, "name")`,
    and `kind` must be a member of `DISCOVERY_STATEMENT_KINDS` (bail
    otherwise).
  - `References` — `bounded_items(…, 0, MAX_REFERENCE_PAGE_ITEMS,
    "references")`; per item validate `from_node_id`, `kind`
    (`MAX_ID_BYTES`, non-empty), `module_id`.

- [ ] **Step 6: Run to green** —
  `cargo test -p strata-kernel --bin strata-kernel-service` — expected:
  PASS.

- [ ] **Step 7: Extend protocol.ts** — mirror everything:

```ts
const MAX_MODULE_PAGE_ITEMS = 64;
const MAX_MODULE_DECLARATION_PAGE_ITEMS = 64;
const MAX_REFERENCE_PAGE_ITEMS = 256;
const MAX_MODULE_PATH_BYTES = 512;

export const discoveryStatementKindSchema = z.enum([
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
  "ClassDeclaration",
  "FunctionDeclaration",
  "FirstStatement"
]);

const modulePathSchema = z.string().superRefine((value, context) => {
  if (value.length === 0) context.addIssue({ code: "custom", message: "module path must not be empty" });
  if (utf8Length(value) > MAX_MODULE_PATH_BYTES) {
    context.addIssue({ code: "custom", message: `module path exceeds ${MAX_MODULE_PATH_BYTES} UTF-8 bytes` });
  }
  if (value.startsWith("/") || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "module path must be corpus-relative POSIX" });
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "module path contains an invalid segment" });
  }
});
```

  Request actions (added to `requestActionSchema`'s discriminated union;
  `find_declarations` extended in place):

```ts
  z.object({
    type: z.literal("find_declarations"),
    name: boundedString(MAX_ID_BYTES),
    kind: declarationKindFilterSchema.optional(),
    moduleId: opaqueIdSchema.optional(),
    afterNodeId: opaqueIdSchema.optional()
  }).strict(),
  z.object({
    type: z.literal("list_modules"),
    afterModuleId: opaqueIdSchema.optional(),
    limit: z.number().int().min(1).max(MAX_MODULE_PAGE_ITEMS)
  }).strict(),
  z.object({
    type: z.literal("list_module_declarations"),
    moduleId: opaqueIdSchema,
    afterNodeId: opaqueIdSchema.optional(),
    limit: z.number().int().min(1).max(MAX_MODULE_DECLARATION_PAGE_ITEMS)
  }).strict(),
  z.object({
    type: z.literal("get_references"),
    nodeId: opaqueIdSchema,
    afterReferenceKey: opaqueIdSchema.optional(),
    limit: z.number().int().min(1).max(MAX_REFERENCE_PAGE_ITEMS)
  }).strict(),
```

  Response results (added to `responseResultSchema`; `declarations`
  extended in place):

```ts
  z.object({
    type: z.literal("declarations"),
    graphGeneration: canonicalU64Schema,
    declarations: z.array(declarationSummarySchema).max(MAX_DECLARATION_MATCHES),
    hasMore: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("modules"),
    graphGeneration: canonicalU64Schema,
    modules: z.array(
      z.object({
        moduleId: opaqueIdSchema,
        path: modulePathSchema,
        declarationCount: z.number().int().min(0)
      }).strict()
    ).max(MAX_MODULE_PAGE_ITEMS),
    hasMore: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("module_declarations"),
    graphGeneration: canonicalU64Schema,
    declarations: z.array(
      z.object({
        nodeId: opaqueIdSchema,
        name: z.string().min(1).nullable(),
        kind: discoveryStatementKindSchema,
        exported: z.boolean()
      }).strict()
    ).max(MAX_MODULE_DECLARATION_PAGE_ITEMS),
    hasMore: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("references"),
    graphGeneration: canonicalU64Schema,
    references: z.array(
      z.object({
        fromNodeId: opaqueIdSchema,
        kind: boundedString(MAX_ID_BYTES),
        moduleId: opaqueIdSchema
      }).strict()
    ).max(MAX_REFERENCE_PAGE_ITEMS),
    hasMore: z.boolean()
  }).strict(),
```

  `MUTATING_ACTIONS` is deliberately unchanged.

- [ ] **Step 8: Update the shared golden fixtures.** In `accepted.json` add
  request+response case pairs following the existing naming style
  (`hello-request` / `ready-response`):
  - `list-modules-request` (with `afterModuleId` present) and
    `list-modules-first-page-request` (without it);
  - `modules-response` (two modules, `hasMore: true`);
  - `list-module-declarations-request`;
  - `module-declarations-response` (one named exported declaration, one
    `name: null` non-exported `FirstStatement`, `hasMore: false`);
  - `get-references-request` (with `afterReferenceKey`);
  - `references-response`;
  - `find-declarations-scoped-request` (with `moduleId` + `afterNodeId`).

  Update the EXISTING `declarations-response` case to include
  `"hasMore": false` (the field is now required by both parsers).

  In `rejected.json` add:
  - `list-modules-limit-zero-request`, `list-modules-limit-65-request`,
    `get-references-limit-257-request`;
  - `modules-response-absolute-path` (path `"/etc/passwd"`),
    `modules-response-dotdot-path` (path `"src/../x.ts"`);
  - `module-declarations-response-unknown-kind`;
  - `list-modules-request-idempotency-key` (a `list_modules` request
    carrying `idempotencyKey`, proving read-only classification on both
    sides);
  - `find-declarations-empty-module-id-request`.

- [ ] **Step 9: Update TS tests.** Extend
  `packages/live-compare/tests/protocol.test.ts`: the fixture-driven suites
  pick the new cases up automatically; update the inline
  `find_declarations`/declarations round-trip test (~line 165) for
  `hasMore`, and add one inline round-trip per new action/result pair in
  the same style. Sweep the whole live-compare tree for hand-built
  `declarations` results (`grep -rn '"declarations"' packages/live-compare
  --include='*.ts' -l | grep -v dist`) and add `hasMore` — the KNOWN site
  is the `tools.test.ts:24-27` fake client's `findDeclarations` stub.

- [ ] **Step 10: Run both suites to green.**
  - `cargo test -p strata-kernel --bin strata-kernel-service`
  - `cargo test -p strata-kernel --test local_service`
  - `cargo test -p strata-kernel` (whole crate — catches every consumer of
    the protocol module)
  - `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare build`
  - `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test protocol tools`
  Expected: PASS all.

- [ ] **Step 11: Commit** (explicit paths; never `src/tasks.ts`):

```bash
git add crates/strata-kernel/src/kernel.rs crates/strata-kernel/src/lib.rs crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs crates/strata-kernel/src/bin/strata_kernel_service/session.rs packages/live-compare/src/protocol.ts packages/live-compare/tests/fixtures/protocol-v1 packages/live-compare/tests/protocol.test.ts packages/live-compare/tests/tools.test.ts
git commit -m "feat(kernel): B-1 wire contract — list_modules/list_module_declarations/get_references + paged find_declarations, dual-language + golden fixtures"
```

---

### Task 2: Fail-closed module path projection

**Files:**
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/paths.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs`
  (`mod paths;`, add `corpus_root` to `ServiceConfig` construction)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
  (`ServiceConfig` field, canonicalize at `open`)

**Interfaces:**
- Produces:
  ```rust
  // paths.rs
  pub(super) fn project_module_path(canonical_corpus_root: &Path, payload: &str) -> Result<String>
  ```
  and `ServiceConfig { …, pub corpus_root: PathBuf }`, plus a
  `canonical_corpus_root: PathBuf` field on `ServiceSession` populated in
  `ServiceSession::open` via `std::fs::canonicalize` (startup fails loudly
  on error).
- Consumes: `super::protocol::MAX_MODULE_PATH_BYTES` (Task 1).
- Consumed by: Task 4's `list_modules` handler.

- [ ] **Step 1: Declare the module with a bailing stub + the failing
  tests.** Add `mod paths;` to main.rs FIRST (without this the test file
  is never compiled and a filtered `cargo test` "passes" with zero tests —
  review Finding 3). paths.rs starts as:

```rust
use std::path::Path;

use anyhow::{Result, bail};

pub(super) fn project_module_path(
    _canonical_corpus_root: &Path,
    _payload: &str,
) -> Result<String> {
    bail!("unimplemented")
}
```

  plus the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        // Canonicalize a real directory so prefix logic sees resolved paths,
        // matching what ServiceSession::open produces.
        std::fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap()
    }

    #[test]
    fn relative_payload_projects_verbatim_as_posix() {
        assert_eq!(project_module_path(&root(), "src/types/user.ts").unwrap(), "src/types/user.ts");
    }

    #[test]
    fn absolute_payload_under_root_projects_corpus_relative() {
        let payload = root().join("src/index.ts");
        assert_eq!(project_module_path(&root(), payload.to_str().unwrap()).unwrap(), "src/index.ts");
    }

    #[test]
    fn absolute_payload_outside_root_fails_closed_without_leaking_payload() {
        let error = project_module_path(&root(), "/definitely/outside/evil.ts").unwrap_err();
        let message = format!("{error:#}");
        assert!(!message.contains("evil.ts"), "error must not leak the payload: {message}");
    }

    #[test]
    fn dot_dot_dot_and_doubled_separator_components_fail_closed() {
        for payload in ["../escape.ts", "src/../escape.ts", "./src/x.ts", "src/./x.ts", "src//x.ts"] {
            assert!(project_module_path(&root(), payload).is_err(), "{payload:?} must fail");
        }
    }

    #[test]
    fn empty_and_backslash_payloads_fail_closed() {
        for payload in ["", "src\\win.ts"] {
            assert!(project_module_path(&root(), payload).is_err(), "{payload:?} must fail");
        }
    }

    #[test]
    fn root_itself_fails_closed() {
        assert!(project_module_path(&root(), root().to_str().unwrap()).is_err());
    }

    #[test]
    fn over_long_projection_fails_closed() {
        let payload = format!("src/{}.ts", "a".repeat(600));
        assert!(project_module_path(&root(), &payload).is_err());
    }
}
```

- [ ] **Step 2: Run to verify genuine failure** —
  `cargo test -p strata-kernel --bin strata-kernel-service paths` —
  expected: the positive tests FAIL against the bailing stub; confirm the
  runner reports a NON-ZERO test count (the module is compiled).

- [ ] **Step 3: Implement.** Validation happens on RAW STRING SEGMENTS
  before any `Path` iteration — `Path::components()` silently normalizes
  `.` and doubled separators and must not be the validator (review
  Finding 2):

```rust
use std::path::Path;

use anyhow::{Result, bail};

use super::protocol::MAX_MODULE_PATH_BYTES;

/// Derives the corpus-relative POSIX display path for one Module payload.
///
/// Fail-closed contract (item-B spec, review Major): payloads may be
/// corpus-relative POSIX paths (the seeded form) or physical ABSOLUTE paths
/// (recorded harness precedent). Anything else — escape outside the
/// canonical corpus root, `.`/`..`/empty segments, backslashes, an empty
/// projection, an over-long projection — is an error, and NO error path may
/// embed the raw payload. Projection is lexical over raw `/`-separated
/// segments: the payload is never touched on the filesystem, so results are
/// deterministic for nodes whose rendered file does not currently exist,
/// and an absolute payload that only matches the corpus root through a
/// symlink alias fails closed by design.
pub(super) fn project_module_path(
    canonical_corpus_root: &Path,
    payload: &str,
) -> Result<String> {
    if payload.is_empty() {
        bail!("module payload is empty");
    }
    if payload.contains('\\') {
        bail!("module payload contains a backslash");
    }
    let relative = if let Some(stripped) = payload.strip_prefix('/') {
        let root = canonical_corpus_root
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("corpus root is not valid UTF-8"))?;
        let root_relative = format!("/{stripped}");
        let Some(remainder) = root_relative.strip_prefix(root) else {
            bail!("module payload escapes the corpus root");
        };
        let Some(remainder) = remainder.strip_prefix('/') else {
            // Either the payload IS the root, or the prefix match ended
            // mid-segment (e.g. root `/corpus` vs payload `/corpusX/f.ts`).
            bail!("module payload escapes the corpus root");
        };
        remainder.to_owned()
    } else {
        payload.to_owned()
    };
    if relative.is_empty() {
        bail!("module payload projects to an empty path");
    }
    if relative
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        bail!("module payload contains an invalid path segment");
    }
    if relative.len() > MAX_MODULE_PATH_BYTES {
        bail!("module path projection exceeds {MAX_MODULE_PATH_BYTES} UTF-8 bytes");
    }
    Ok(relative)
}
```

  (The canonical corpus root from `std::fs::canonicalize` is absolute
  without a trailing slash, so `strip_prefix(root)` followed by a
  mandatory `/` cannot false-positive on sibling directories that share a
  name prefix.)

- [ ] **Step 4: Thread the corpus root.** In session.rs add
  `pub corpus_root: PathBuf` to `ServiceConfig` and
  `canonical_corpus_root: PathBuf` to `ServiceSession`; in
  `ServiceSession::open`, before kernel open:

```rust
        let canonical_corpus_root = std::fs::canonicalize(&config.corpus_root)
            .with_context(|| format!("canonicalize --corpus-root {}", config.corpus_root.display()))?;
```

  and store it in the `Arc::new(Self { … })` literal. In main.rs `serve`,
  pass `corpus_root: corpus_root.clone()` into `ServiceConfig` (clone
  BEFORE it moves into `NodeBridgeConfig::tsc_only`). No argv change; the
  flag already exists and stays required.

- [ ] **Step 5: Run tests** —
  `cargo test -p strata-kernel --bin strata-kernel-service` — expected:
  PASS. Also `cargo build -p strata-kernel` and
  `cargo test -p strata-kernel --test local_service` (the daemon now
  canonicalizes at startup; its corpus roots are real directories).

- [ ] **Step 6: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/paths.rs crates/strata-kernel/src/bin/strata_kernel_service/main.rs crates/strata-kernel/src/bin/strata_kernel_service/session.rs
git commit -m "feat(kernel): fail-closed corpus-relative module path projection + corpus-root threading"
```

---

### Task 3: Kernel query methods

**Files:**
- Modify: `crates/strata-kernel/src/kernel.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
  (`find_declarations` call site gains the new arguments and the REAL
  `has_more` — replacing Task 1's truthful placeholder)
- Test: `crates/strata-kernel/tests/discovery_queries.rs` (NEW)

**Interfaces:**
- Consumes: `GraphGeneration::{nodes, children_of, references_to, node}`
  (graph.rs — all id-ordered, no snapshot materialization),
  `confirmed_declaration_name` (bridge/provider.rs, already imported).
- Produces (public API on `Kernel`):

```rust
pub struct ModuleEntry {
    pub module_id: String,
    /// RAW payload — projection to a display path is the service's job.
    pub payload: String,
    pub declaration_count: u32,
}

pub struct ModuleDeclarationEntry {
    pub node_id: String,
    pub name: Option<String>,
    pub kind: String,
    pub exported: bool,
}

pub struct IncomingReference {
    pub from_node_id: String,
    pub kind: String,
    pub module_id: String,
}

impl Kernel {
    pub fn list_modules(&self, after_module_id: Option<&str>, limit: usize)
        -> Result<(u64, Vec<ModuleEntry>, bool)>;
    pub fn list_module_declarations(&self, module_id: &str, after_node_id: Option<&str>, limit: usize)
        -> Result<(u64, Vec<ModuleDeclarationEntry>, bool)>;
    pub fn find_declarations(&self, name: &str, kind: Option<&str>, module_id: Option<&str>, after_node_id: Option<&str>)
        -> Result<(u64, Vec<DeclarationMatch>, bool)>;   // CHANGED signature
    pub fn incoming_references(&self, node_id: &str, after_from_node_id: Option<&str>, limit: usize)
        -> Result<(u64, Vec<IncomingReference>, bool)>;
}
```

- `incoming_references` uses SUBTREE semantics (see header): a reference
  qualifies iff its `to_node_id` is in the subtree rooted at `node_id` AND
  its `from_node_id` is outside that subtree; results are globally ordered
  by `from_node_id`. Subtree traversal is bounded by
  `MAX_REFERENCE_SUBTREE_NODES = 65_536` (fail closed beyond).
- Consumed by: Task 4 session handlers; Task 7 indirectly over the wire.

- [ ] **Step 1: Write failing tests in
  `crates/strata-kernel/tests/discovery_queries.rs`.** Build small
  `GraphSnapshot`s directly (same style as `coordination_model.rs` /
  `graph_generation.rs` — follow whichever helper pattern those files use
  for constructing `NodeRecord`s). Fixture: three modules `module:a`
  (payload `src/a.ts`), `module:b` (payload `src/b.ts`), `module:c`
  (payload `src/c.ts`); `module:a` has children: `stmt:a1`
  (`FunctionDeclaration`, payload `export function alpha() {}` with an
  `Identifier` child `ident:a1name` carrying the name-token payload —
  copy the exact `{"text":…,"offset":…}` convention from an existing
  fixture that exercises `find_declarations`, e.g. the snapshot used in
  `examples_medium_fixture.rs`, rather than guessing), `stmt:a2`
  (`FirstStatement`, payload `const x = 1;`, no identifier →
  `name: None`, not exported), `stmt:a3` (`ExpressionStatement` — must be
  EXCLUDED from counts and listings). References `ref-from` nodes live in
  `module:b`/`module:c` and point at `ident:a1name` (the name-identifier
  child — matching real ingest, which never targets the statement node;
  `packages/store/src/resolveReferences.ts:61-63`).

  Cases (one `#[test]` each):
  - `list_modules_pages_deterministically_in_id_order`: limit 2 → 2 modules
    + `has_more true`; cursor walk (limit 2 then cursor) equals single
    limit-64 page; both walks repeated give identical results.
  - `list_modules_counts_only_discovery_statement_kinds`: `module:a`
    declaration_count == 2 (`stmt:a3` excluded).
  - `list_modules_rejects_out_of_bound_limits`: 0 and 65 error.
  - `list_module_declarations_lists_names_export_flags_and_nulls`:
    `stmt:a1` → name `Some("alpha")`, exported true; `stmt:a2` → name
    `None`, exported false; `stmt:a3` absent; order is id-ascending;
    pagination cursor works (limit 1 walk == full page).
  - `list_module_declarations_rejects_non_module_target`: `stmt:a1` as
    module_id errors; unknown id errors.
  - `exported_payload_parity_with_product_discovery`: unit-test
    `is_exported_payload` (exposed `pub(crate)` or tested via listing
    entries) for the product-parity edge cases (review Finding 7):
    leading `// comment\nexport const…` → true; `/* block */ export…` →
    true; unterminated `/* …` → false; `//` with no trailing newline →
    false; `exports.foo = 1` → TRUE (intentionally boundary-free, exact
    product behavior); leading whitespace-only + `export` → true.
  - `find_declarations_pages_instead_of_failing_past_64`: snapshot with 70
    same-name function declarations across modules → first call returns 64
    + `has_more true`; cursor call returns remaining 6 + `has_more false`;
    union is all 70; ordering id-ascending. (Replaces the old
    `ensure!`-bail; no existing test pins that failure — verified by
    grep.)
  - `find_declarations_module_scope_filters_to_one_module`: scoped to
    `module:a` finds `alpha`; scoped to `module:b` finds nothing; global
    behavior for the same name unchanged.
  - `incoming_references_aggregate_subtree_and_page_by_from_node_id`:
    `incoming_references("stmt:a1", …)` returns the refs targeting
    `ident:a1name` (subtree aggregation — direct `references_to` on the
    statement is empty); a reference between two nodes INSIDE the subtree
    is excluded; limit 2 + cursor walk equals full page; each reference's
    `module_id` is the from-node's root module; unknown target errors;
    limits 0/257 error.
  - `incoming_references_fails_closed_on_broken_parent_chain`: a from-node
    whose parent chain hits a missing node (or whose root is not a
    Module) errors rather than mis-attributing.

- [ ] **Step 2: Run to verify failure** —
  `cargo test -p strata-kernel --test discovery_queries` — expected: FAIL
  to compile (methods absent). Add the method signatures with
  `bail!("unimplemented")` bodies if a compiling red is preferred; either
  way confirm a genuine red before Step 3.

- [ ] **Step 3: Implement in kernel.rs.**

  Shared helpers:

```rust
/// True for the persisted top-level statement kinds the discovery surface
/// lists and counts — exactly the kinds `PRODUCT_KINDS` maps to.
fn is_discovery_statement_kind(kind: &str) -> bool {
    PRODUCT_KINDS.iter().any(|(_, statement)| *statement == kind)
}

/// Mirrors `isExportedPayload` in packages/store/src/discovery.ts: skip
/// leading whitespace and `//` / `/* */` comments, then test for a literal
/// `export` prefix. Intentionally byte-for-byte the product semantics,
/// including the absence of a word-boundary check.
pub(crate) fn is_exported_payload(payload: &str) -> bool {
    let mut rest = payload;
    loop {
        let trimmed = rest.trim_start_matches([' ', '\t', '\n', '\r']);
        if let Some(after) = trimmed.strip_prefix("//") {
            match after.find('\n') {
                Some(index) => rest = &after[index + 1..],
                None => return false,
            }
        } else if let Some(after) = trimmed.strip_prefix("/*") {
            match after.find("*/") {
                Some(index) => rest = &after[index + 2..],
                None => return false,
            }
        } else {
            return trimmed.starts_with("export");
        }
    }
}

const MAX_MODULE_ANCESTOR_DEPTH: usize = 4_096;
const MAX_REFERENCE_SUBTREE_NODES: usize = 65_536;

fn module_ancestor(graph: &GraphGeneration, node_id: &str) -> Result<String> {
    let mut current = graph
        .node(node_id)
        .with_context(|| format!("node {node_id} does not exist"))?;
    let mut steps = 0usize;
    while let Some(parent_id) = current.parent_id.as_deref() {
        steps += 1;
        ensure!(
            steps <= MAX_MODULE_ANCESTOR_DEPTH,
            "node {node_id} parent chain exceeds the supported depth"
        );
        current = graph
            .node(parent_id)
            .with_context(|| format!("node {parent_id} is missing from the graph"))?;
    }
    ensure!(
        current.kind == "Module",
        "node {node_id} does not root at a Module"
    );
    Ok(current.id.clone())
}

/// The IDs of `root` and every transitive child, bounded fail-closed.
fn bounded_subtree(graph: &GraphGeneration, root: &str) -> Result<BTreeSet<String>> {
    let mut subtree = BTreeSet::from([root.to_owned()]);
    let mut queue = vec![root.to_owned()];
    while let Some(parent) = queue.pop() {
        for child in graph.children_of(&parent) {
            ensure!(
                subtree.len() < MAX_REFERENCE_SUBTREE_NODES,
                "node {root} subtree exceeds the supported bound"
            );
            if subtree.insert(child.id.clone()) {
                queue.push(child.id.clone());
            }
        }
    }
    Ok(subtree)
}
```

  `list_modules` — validate `limit` against `1..=MAX_MODULE_PAGE_ITEMS`;
  iterate `graph.nodes()` (id-ordered, no clone), filter
  `kind == "Module"`, cursor skip (`node.id <= after`), stop at `limit`
  with `has_more = true` when a further module exists,
  `declaration_count = u32::try_from(graph.children_of(&node.id).filter(|c| is_discovery_statement_kind(&c.kind)).count()).context("module declaration count overflow")?`.

  `list_module_declarations` — resolve module (`node()` +
  `kind == "Module"` ensure), iterate `graph.children_of(module_id)`
  (id-ordered), filter discovery kinds, cursor + limit as above; per
  declaration build the one-entry identifiers map and reuse
  `confirmed_declaration_name`:

```rust
            let identifier_children: Vec<&NodeRecord> = graph
                .children_of(&child.id)
                .filter(|node| node.kind == "Identifier")
                .collect();
            let mut identifiers = BTreeMap::new();
            identifiers.insert(child.id.as_str(), identifier_children);
            let name = confirmed_declaration_name(child, &identifiers)
                .ok()
                .flatten();
```

  (`children_of` yields `&NodeRecord`; if borrow shapes fight, collect the
  page's declaration references into a `Vec<&NodeRecord>` first, then
  resolve names in a second loop.) `exported: is_exported_payload(&child.payload)`.

  `find_declarations` — keep the current single-pass structure and the ONE
  snapshot clone for the global path; changes: (a) when `module_id` is
  `Some`, resolve + ensure it is a Module, and restrict the candidate loop
  to that module's children (identifiers map built from those children's
  Identifier children only); (b) apply the `after_node_id` cursor skip;
  (c) replace the `ensure!(matches.len() <= MAX_DECLARATION_MATCHES …)`
  bail with: collect up to `MAX_DECLARATION_MATCHES`, set
  `has_more = true` on the first match past the page, `break`. Return
  `(generation, matches, has_more)`. Update the doc comment: the 64-bound
  is now a page, not a failure.

  `incoming_references` — validate limit `1..=MAX_REFERENCE_PAGE_ITEMS`;
  target must exist; `let subtree = bounded_subtree(&graph, node_id)?;`
  then collect qualifying references globally ordered by `from_node_id`:
  iterate the subtree's members, `graph.references_to(member)` for each,
  keep refs with `!subtree.contains(&reference.from_node_id)`, insert into
  a `BTreeMap<String, &ReferenceRecord>` keyed by `from_node_id` (unique —
  one outgoing reference per from node), then cursor skip + limit +
  `has_more` over the map iteration, attributing each survivor with
  `module_ancestor(&graph, from_node_id)?`.

- [ ] **Step 4: Fix call sites of the changed `find_declarations`
  signature.** `cargo build -p strata-kernel` and let the compiler list
  them. session.rs `execute_read` now passes the real arguments and the
  REAL `has_more` (replacing Task 1's placeholder):

```rust
            RequestAction::FindDeclarations { name, kind, module_id, after_node_id } => {
                let (generation, matches, has_more) = self.kernel.find_declarations(
                    name,
                    kind.as_deref(),
                    module_id.as_deref(),
                    after_node_id.as_deref(),
                )?;
                Ok(ResponseResult::Declarations {
                    graph_generation: WireU64::new(generation),
                    declarations: matches
                        .into_iter()
                        .map(|declaration| DeclarationSummary {
                            node_id: declaration.node_id,
                            kind: declaration.kind,
                            name: declaration.name,
                            module_id: declaration.module_id,
                        })
                        .collect(),
                    has_more,
                })
            }
```

  Any other call sites (tests, feature-gated helpers) get `None, None` and
  the tuple destructure.

- [ ] **Step 5: Run** —
  `cargo test -p strata-kernel --test discovery_queries` then the crate
  suite `cargo test -p strata-kernel` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/strata-kernel/src/kernel.rs crates/strata-kernel/src/lib.rs crates/strata-kernel/tests/discovery_queries.rs crates/strata-kernel/src/bin/strata_kernel_service/session.rs
git commit -m "feat(kernel): paged discovery queries — list_modules, list_module_declarations, scoped find_declarations, subtree incoming_references"
```

---

### Task 4: Session read handlers + daemon integration gates

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
  (`execute_read` — ONLY the three new handlers; `find_declarations` was
  finished in Task 3)
- Test: `crates/strata-kernel/tests/local_service.rs`

**Interfaces:**
- Consumes: Task 1 protocol variants, Task 2 `project_module_path` +
  `canonical_corpus_root`, Task 3 kernel methods.
- Produces: wire behavior for the three new actions; read errors surface
  through the existing `request_failed` path with bounded messages.

- [ ] **Step 1: Write failing daemon integration tests in
  local_service.rs.** ALL test names share the `discovery_` prefix so one
  filtered run covers the full set (review Finding 3). They use the
  spawned production binary via the existing `start_service`/`request`
  helpers; the localized snapshot seeds Module payloads as physical
  ABSOLUTE paths under `examples/medium`, so these tests inherently
  exercise the absolute-payload projection branch:

  - `discovery_list_modules_projects_absolute_payloads_and_pages_deterministically`:
    walk with `limit: 1` accumulating pages until `hasMore == false`;
    assert every page of the walk reports the SAME `graphGeneration`;
    assert every `path` starts with `"src/"`, does not start with `"/"`,
    and contains no `".."`/`"\\"`; assert the walk equals one `limit: 64`
    page; assert `declarationCount >= 1` for the module whose path is
    `"src/types/user.ts"`.
  - `discovery_list_module_declarations_matches_registered_target`: find
    the module with path `"src/types/user.ts"` via `list_modules`, list
    its declarations, assert an entry with `name == "User"`,
    `kind == "InterfaceDeclaration"`, `exported == true`, and
    `nodeId == USER_ID` (the existing test constant).
  - `discovery_scoped_find_declarations_resolves_without_global_lookup`:
    `find_declarations` with `moduleId` set → exactly the `USER_ID` match,
    `hasMore false`; the same request against a DIFFERENT module → empty
    (the wrong-module negative control the bootstrap gate leans on).
  - `discovery_get_references_pages_and_attributes_modules`:
    `get_references` on `USER_ID` with `limit: 1` walked to exhaustion
    equals one `limit: 256` page; assert non-empty (subtree semantics —
    refs target the name identifier inside `USER_ID`'s subtree); every
    `moduleId` appears in the `list_modules` walk; unknown `nodeId` →
    `ok: false` with code `request_failed`.
  - `discovery_list_modules_fails_closed_on_escaping_module_payload`:
    build a variant localized snapshot where ONE module payload is
    rewritten to an absolute path OUTSIDE the corpus root (e.g. the
    tempdir itself), start a service on it, assert `list_modules` returns
    `ok: false`, code `request_failed`, message contains the module ID but
    NOT the payload string; assert `hello` and `find_declarations` still
    work (fail-closed is per-request, not per-daemon).
  - `discovery_read_actions_reject_idempotency_keys`: `list_modules` with
    an `idempotencyKey` → protocol-level rejection (mirrors the fixture
    case end-to-end).

- [ ] **Step 2: Run to verify genuine failure** —
  `cargo test -p strata-kernel --test local_service discovery_` — expected:
  ALL six FAIL (the three new actions hit "mutating action cannot use the
  read path" → `request_failed`).

- [ ] **Step 3: Implement the three `execute_read` arms in session.rs**

```rust
            RequestAction::ListModules { after_module_id, limit } => {
                let (generation, entries, has_more) = self
                    .kernel
                    .list_modules(after_module_id.as_deref(), *limit as usize)?;
                let modules = entries
                    .into_iter()
                    .map(|entry| {
                        let path = project_module_path(&self.canonical_corpus_root, &entry.payload)
                            .with_context(|| {
                                format!("module {} has a non-projectable path payload", entry.module_id)
                            })?;
                        Ok(ModuleSummary {
                            module_id: entry.module_id,
                            path,
                            declaration_count: entry.declaration_count,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(ResponseResult::Modules {
                    graph_generation: WireU64::new(generation),
                    modules,
                    has_more,
                })
            }
            RequestAction::ListModuleDeclarations { module_id, after_node_id, limit } => {
                let (generation, entries, has_more) = self.kernel.list_module_declarations(
                    module_id,
                    after_node_id.as_deref(),
                    *limit as usize,
                )?;
                Ok(ResponseResult::ModuleDeclarations {
                    graph_generation: WireU64::new(generation),
                    declarations: entries
                        .into_iter()
                        .map(|entry| ModuleDeclarationSummary {
                            node_id: entry.node_id,
                            name: entry.name,
                            kind: entry.kind,
                            exported: entry.exported,
                        })
                        .collect(),
                    has_more,
                })
            }
            RequestAction::GetReferences { node_id, after_reference_key, limit } => {
                let (generation, references, has_more) = self.kernel.incoming_references(
                    node_id,
                    after_reference_key.as_deref(),
                    *limit as usize,
                )?;
                Ok(ResponseResult::References {
                    graph_generation: WireU64::new(generation),
                    references: references
                        .into_iter()
                        .map(|reference| ReferenceSummary {
                            from_node_id: reference.from_node_id,
                            kind: reference.kind,
                            module_id: reference.module_id,
                        })
                        .collect(),
                    has_more,
                })
            }
```

  Import `project_module_path` and the new summary structs. Keep the
  mutating-action bail arm as the `_` fallthrough.

- [ ] **Step 4: Run** —
  `cargo test -p strata-kernel --test local_service discovery_` to green,
  then `cargo test -p strata-kernel --test local_service` and
  `cargo test -p strata-kernel` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/session.rs crates/strata-kernel/tests/local_service.rs
git commit -m "feat(kernel): serve paged discovery reads with fail-closed path projection over the wire"
```

---

### Task 5: TS client wrappers

**Files:**
- Modify: `packages/live-compare/src/client.ts`
- Modify: call sites of `findDeclarations` — BOTH compiled sources AND
  tests (the package tsconfig includes only `src`, so the compiler will
  NOT flag test callers — review Finding 4). Known sites from the review
  + in-session sweep: `src/gate1.ts:351`, `src/gate2.ts:405`,
  `src/tools.ts:72,141` (interface + wrapper),
  `tests/gate1Intrusion.test.ts:213,273,338-341,399`,
  `tests/persistenceMemory.test.ts:170`,
  `tests/persistentBridge.test.ts:100`; re-run the sweep at execution
  time: `grep -rn "findDeclarations(" packages scripts --include='*.ts' | grep -v dist`
- Test: `packages/live-compare/tests/client.test.ts`

**Interfaces:**
- Produces (on `CoordinationClient`):

```ts
findDeclarations(
  name: string,
  options?: {
    kind?: z.infer<typeof declarationKindFilterSchema>;
    moduleId?: string;
    afterNodeId?: string;
  },
  deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
): Promise<CoordinationResult>;
listModules(
  options?: { afterModuleId?: string },
  limit = 64,
  deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
): Promise<CoordinationResult>;
listModuleDeclarations(
  moduleId: string,
  options?: { afterNodeId?: string },
  limit = 64,
  deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
): Promise<CoordinationResult>;
getReferences(
  nodeId: string,
  options?: { afterReferenceKey?: string },
  limit = 256,
  deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
): Promise<CoordinationResult>;
```

  This CHANGES `findDeclarations`' second parameter from a bare `kind` to
  an options object — a deliberate breaking change inside the repo. Vitest
  does NOT typecheck tests, so a missed positional caller fails only at
  runtime with a schema error — the textual sweep and the full-suite run
  are load-bearing, not optional.
- Consumed by: Task 6 tool handlers, Task 7 bootstrap gate.
- `agent.ts`/`liveAdapter.ts` construct the concrete `CoordinationClient`
  (verified: `agent.ts:182-186`, `liveAdapter.ts:192-202`) — no
  conformance shim needed there; the object-literal fake in
  `tests/tools.test.ts` is extended in Task 6.

- [ ] **Step 1: Write failing tests in client.test.ts** following the
  file's existing fake-server pattern: assert each new wrapper serializes
  the exact wire action (`type`, camelCase fields, omitted optionals
  absent, NO `idempotencyKey`), and one EXACT-serialization case for the
  scoped `findDeclarations` (the bootstrap gate's no-global-lookup claim
  leans on this test proving a scoped call carries `moduleId` on the
  wire — review Answer 6).

- [ ] **Step 2: Run to verify failure** —
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test client`
  — expected: FAIL.

- [ ] **Step 3: Implement.** In `isMutating`, extend the read-only list:

```ts
  return ![
    "hello",
    "inspect_nodes",
    "find_declarations",
    "list_modules",
    "list_module_declarations",
    "get_references",
    "read_events",
    "read_operation"
  ].includes(action.type);
```

  Add the four wrappers (spread-omit optional fields exactly like the
  existing `findDeclarations` does with `kind`). Then the call-site sweep:
  run the grep above, fix EVERY positional
  `findDeclarations(name, "interface", DEADLINE)` caller to
  `findDeclarations(name, { kind: "interface" }, DEADLINE)` — sources and
  tests both. `scripts/dogfood/l2.5-prep-find-declarations.ts`: fix if it
  imports the client; leave if it builds raw wire frames (old frames
  without the new optional fields remain valid).

- [ ] **Step 4: Run the FULL package suite** (not just the client filter —
  the sweep's misses surface here):
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare build && PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test`
  — expected: PASS.

- [ ] **Step 5: Commit** (explicit paths; `src/tasks.ts` must NOT appear):

```bash
git add packages/live-compare/src/client.ts packages/live-compare/src/gate1.ts packages/live-compare/src/gate2.ts packages/live-compare/src/tools.ts packages/live-compare/tests/client.test.ts packages/live-compare/tests/gate1Intrusion.test.ts packages/live-compare/tests/persistenceMemory.test.ts packages/live-compare/tests/persistentBridge.test.ts
git status --short   # verify nothing else (especially src/tasks.ts) is staged
git commit -m "feat(live-compare): client wrappers for paged discovery actions"
```

---

### Task 6: Agent tool surface

**Files:**
- Modify: `packages/live-compare/src/tools.ts`
- Test: `packages/live-compare/tests/tools.test.ts` (extend the
  object-literal `fakeClient` with the three new methods + new
  `findDeclarations` signature; update the exact ten-tool snapshot test at
  ~lines 65-85 to the new thirteen-name list)

**Interfaces:**
- Consumes: Task 5 client methods via `CoordinationClientApi` (extend the
  interface with `listModules`, `listModuleDeclarations`, `getReferences`
  and the new `findDeclarations` options signature).
- Produces: three new MCP tools + extended `find_declarations` input
  schema; `COORDINATION_TOOL_NAMES` grows to 13 entries.

- [ ] **Step 1: Write failing tests in tools.test.ts** (follow the file's
  existing pattern): updated tool-name list snapshot; each new tool's
  schema rejects unknown fields and out-of-bound limits; each handler
  forwards parsed args to the right client method (snake_case tool args →
  camelCase client args).

- [ ] **Step 2: Run to verify failure** —
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test tools`.

- [ ] **Step 3: Implement.** Input schemas:

```ts
  find_declarations: z
    .object({
      name: z.string().min(1).max(MAX_ID_CHARS),
      kind: z.enum(["interface", "type-alias", "class", "function", "variable"]).optional(),
      module_id: stableId.optional(),
      after_node_id: stableId.optional()
    })
    .strict(),
  list_modules: z
    .object({
      after_module_id: stableId.optional(),
      limit: z.number().int().min(1).max(64)
    })
    .strict(),
  list_module_declarations: z
    .object({
      module_id: stableId,
      after_node_id: stableId.optional(),
      limit: z.number().int().min(1).max(64)
    })
    .strict(),
  get_references: z
    .object({
      node_id: stableId,
      after_reference_key: stableId.optional(),
      limit: z.number().int().min(1).max(256)
    })
    .strict(),
```

  Tool descriptions (part of the agent's worldview — keep this register):

  - `list_modules`: "List the modules of the codebase as a bounded page:
    each entry is a stable module ID, its corpus-relative display path, and
    how many top-level declarations it holds. Start discovery here when you
    have no IDs. Pass the last moduleId as after_module_id to fetch the
    next page while hasMore is true; if graphGeneration changes between
    pages, restart from the first page. The path is display metadata only —
    every operation takes the moduleId, never a path."
  - `list_module_declarations`: "List one module's top-level declarations —
    including non-exported ones — as a bounded page of stable node IDs with
    name (null when the declaration has no confirmable name), kind, and
    whether it is exported. Use after list_modules to locate a declaration
    by name without a global search, then inspect_nodes or get_references
    on the returned IDs."
  - `find_declarations` (updated): "Find declarations by exact name,
    optionally narrowed by kind (interface, type-alias, class, function,
    variable) and/or to one module via module_id. Returns a bounded page of
    stable node IDs with their module; while hasMore is true, pass the last
    nodeId as after_node_id for the next page, and restart pagination if
    graphGeneration changes. Prefer module-scoped lookups once
    list_modules has told you where to look."
  - `get_references`: "List the incoming references to one declaration as a
    bounded page: everything that references the declaration or anything
    inside it, from outside it. Each entry names the referencing node, the
    reference kind, and the module it lives in. Use this to size and locate
    the blast radius of a rename or parameter change before mutating. Pass
    the last fromNodeId as after_reference_key while hasMore is true;
    restart if graphGeneration changes."

  Handlers forward to the client
  (`client.listModules(after_module_id ? { afterModuleId: after_module_id } : undefined, limit)`
  etc.). Extend `CoordinationClientApi` and `COORDINATION_TOOL_NAMES`
  (insert `list_modules`, `list_module_declarations` before
  `find_declarations`; `get_references` after `inspect_nodes`).

- [ ] **Step 4: Run the full package suite** (agent.test.ts consumes the
  generated allowlist and must stay green):
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test`
  — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/live-compare/src/tools.ts packages/live-compare/tests/tools.test.ts
git status --short   # verify src/tasks.ts is not staged
git commit -m "feat(live-compare): discovery tools — list_modules, list_module_declarations, get_references, paged find_declarations"
```

---

### Task 7: Zero-ID discovery-bootstrap gate (acceptance test)

This is an ACCEPTANCE GATE, not failing-first TDD (review Finding 3): it is
written after the behavior exists and proves the spec's gate (b) end to
end. Its probative structure (review Answer 6): the zero-ID property holds
by construction (no ID enters the flow before step 6); the
no-global-lookup property is proven by Task 5's exact-serialization test
for scoped `findDeclarations` plus Task 4's wrong-module negative control,
with the audit count as corroboration only.

**Files:**
- Create: `packages/live-compare/tests/discoveryBootstrap.test.ts`
- Modify: `packages/live-compare/tests/serviceHarness.ts` (export
  `ensureBuilt` if still module-private)

**Interfaces:**
- Consumes: `startKernelService` (service.ts), `CoordinationClient` (Task
  5 wrappers), `createQualifiedTaskManifest` + `materializeFinalTree`
  (assertion-only), `advanceUntilTerminal`/`credentialFreeEnv` from
  `serviceHarness.ts`.
- Produces: the spec's B-1 gate (b).

- [ ] **Step 1: Write the gate test**

```ts
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CoordinationClient } from "../src/client.js";
import { materializeFinalTree, startKernelService } from "../src/service.js";
import { createQualifiedTaskManifest } from "../src/tasks.js";
import { advanceUntilTerminal, credentialFreeEnv, ensureBuilt } from "./serviceHarness.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
// Pinned LITERAL, deliberately not imported from tasks.ts: the in-file
// constant and computation can drift together in one commit; this line
// cannot (review Finding 5).
const FROZEN_REGISTRATION_DIGEST =
  "628bd6dabedc2e99b09375bb3b05da1663e6c25f86933113fd64497c1a140233";
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("zero-ID discovery bootstrap (spec B-1 gate b)", () => {
  it("resolves and publishes a T03-class rename from zero supplied IDs", async () => {
    ensureBuilt();
    const service = await startKernelService(corpusRoot, { env: credentialFreeEnv() });
    cleanups.push(() => service.stop());
    const client = new CoordinationClient({ socketPath: service.socketPath, clientId: "bootstrap:discovery:1" });

    // 1. Enumerate modules with a deliberately small page to exercise the
    //    cursor, and re-walk to pin determinism. NO IDs are known yet.
    //    Every page of a walk must report one generation (review Finding 6).
    const walkModules = async () => {
      const items: { moduleId: string; path: string; declarationCount: number }[] = [];
      const generations = new Set<string>();
      let after: string | undefined;
      for (;;) {
        const response = (await client.listModules(after ? { afterModuleId: after } : undefined, 2)) as any;
        expect(response.type).toBe("modules");
        generations.add(response.graphGeneration);
        items.push(...response.modules);
        if (!response.hasMore) break;
        after = response.modules.at(-1)!.moduleId;
      }
      expect(generations.size).toBe(1);
      return { items, generation: [...generations][0]! };
    };
    const first = await walkModules();
    const second = await walkModules();
    expect(second).toEqual(first);
    for (const module of first.items) {
      expect(module.path.startsWith("/")).toBe(false);
      expect(module.path).not.toMatch(/\\|(?:^|\/)\.\.(?:\/|$)/);
    }

    // 2. Locate the target by NAME via per-module declaration listing —
    //    the flow never calls global find_declarations.
    let discoveredId: string | undefined;
    let discoveredModuleId: string | undefined;
    for (const module of first.items) {
      let after: string | undefined;
      for (;;) {
        const response = (await client.listModuleDeclarations(module.moduleId, after ? { afterNodeId: after } : undefined, 64)) as any;
        expect(response.type).toBe("module_declarations");
        expect(response.graphGeneration).toBe(first.generation);
        for (const declaration of response.declarations) {
          if (declaration.name === "User" && declaration.kind === "InterfaceDeclaration") {
            expect(discoveredId).toBeUndefined();
            discoveredId = declaration.nodeId;
            discoveredModuleId = module.moduleId;
            expect(declaration.exported).toBe(true);
          }
        }
        if (!response.hasMore) break;
        after = response.declarations.at(-1)!.nodeId;
      }
    }
    expect(discoveredId).toBeDefined();

    // 3. Scoped find_declarations must agree with the listing route.
    //    (Task 5's client test proves this call serializes moduleId on the
    //    wire; Task 4's wrong-module control proves scoping is enforced.)
    const scoped = (await client.findDeclarations("User", { kind: "interface", moduleId: discoveredModuleId! })) as any;
    expect(scoped.declarations.map((entry: any) => entry.nodeId)).toEqual([discoveredId]);
    expect(scoped.hasMore).toBe(false);

    // 4. Page the incoming references (limit 1) and compare with one big
    //    page; one generation per walk.
    const walkReferences = async (limit: number) => {
      const items: any[] = [];
      const generations = new Set<string>();
      let after: string | undefined;
      for (;;) {
        const response = (await client.getReferences(discoveredId!, after ? { afterReferenceKey: after } : undefined, limit)) as any;
        expect(response.type).toBe("references");
        generations.add(response.graphGeneration);
        items.push(...response.references);
        if (!response.hasMore) break;
        after = response.references.at(-1)!.fromNodeId;
      }
      expect(generations.size).toBe(1);
      return items;
    };
    const paged = await walkReferences(1);
    expect(paged).toEqual(await walkReferences(256));
    expect(paged.length).toBeGreaterThan(0);
    const moduleIds = new Set(first.items.map((module) => module.moduleId));
    for (const reference of paged) expect(moduleIds.has(reference.moduleId)).toBe(true);

    // 5. Publish the discovered rename through the normal lifecycle.
    const begun = (await client.beginChangeSet("bootstrap: rename discovered User interface")) as any;
    await client.addIntent(begun.changeSetId, { type: "rename_symbol", declarationId: discoveredId!, newName: "Account" });
    await client.submitChangeSet(begun.changeSetId);
    const terminal = await advanceUntilTerminal(client, begun.changeSetId);
    expect(terminal.result.state).toBe("published");
    expect(terminal.result.publicationDigest).toMatch(/^[0-9a-f]{64}$/);

    // 6. ONLY NOW load the sealed manifest. Its constructor re-asserts its
    //    own digest; the pinned literal here additionally proves the
    //    registered corpus is the approved one even if tasks.ts drifted.
    const manifest = createQualifiedTaskManifest(corpusRoot);
    expect(manifest.registrationDigest).toBe(FROZEN_REGISTRATION_DIGEST);
    expect(discoveredId).toBe(manifest.targets.User.stableId);
    // Exact set equality: get_references' subtree semantics computes the
    // same population as the manifest's incomingReferenceIds.
    expect([...new Set(paged.map((reference: any) => reference.fromNodeId))].sort()).toEqual(
      manifest.targets.User.incomingReferenceIds
    );

    // 7. Materialize and spot-check the rename landed.
    const tree = await materializeFinalTree(client, corpusRoot, manifest, terminal.result.affectedNodeIds);
    cleanups.push(() => rmSync(tree, { recursive: true, force: true }));
    const userModule = readFileSync(join(tree, "src/types/user.ts"), "utf8");
    expect(userModule).toContain("interface Account");
    expect(userModule).not.toMatch(/\binterface User\b/);

    // 8. Corroboration (not proof — audit records carry no arguments): the
    //    flow's single find_declarations action is the scoped call above.
    const auditActions = readFileSync(service.auditPath, "utf8")
      .trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line).event.action).filter(Boolean);
    expect(auditActions.filter((action) => action === "find_declarations")).toHaveLength(1);
  }, 240_000);
});
```

  Adjust helper import names/shapes to what serviceHarness.ts actually
  exports (`ensureBuilt` is module-private today — export it). If the
  audit event shape differs from `JSON.parse(line).event.action`, match
  whatever `runQualifiedServicePacket` already does with
  `service.auditPath`.

- [ ] **Step 2: Run the gate** —
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test discoveryBootstrap`
  — expected: PASS. If the exact-equality assertion in step 6 fails,
  compare the two populations before touching either side: the gate is
  allowed to surface a real semantics mismatch between `get_references`
  and the manifest — investigate, do not weaken the assertion to a subset
  check without logging a decision.

- [ ] **Step 3: Guard the frozen-manifest invariant** — run
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test tasks`
  and `git log --oneline -1 -- packages/live-compare/src/tasks.ts` (must
  predate this slice's first commit; the working tree AND the branch
  history must both leave tasks.ts untouched). Expected: tasks suite PASS,
  no B-1 commit touches the file.

- [ ] **Step 4: Commit**

```bash
git add packages/live-compare/tests/discoveryBootstrap.test.ts packages/live-compare/tests/serviceHarness.ts
git commit -m "test(live-compare): zero-ID discovery-bootstrap gate — resolve and publish T03-class rename with no supplied IDs"
```

---

### Task 8: Gate wiring, full key-free chain, closing records

**Files:**
- Modify: `package.json` (repo root)
- Modify: `decisions.md`, `docs/product-roadmap.md`

**Interfaces:**
- Produces: `pnpm kernel:discovery:test`; `kernel:full-key-free:test`
  includes it; spec B-1 gates (a)–(c) all runnable key-free.

- [ ] **Step 1: Add the gate script** to root `package.json`, matching the
  other gate scripts' build-prefix style:

```json
"kernel:discovery:test": "pnpm --filter @strata-code/kernel-bridge build && pnpm --filter @strata-code/live-compare build && cargo build -p strata-kernel && pnpm --filter @strata-code/live-compare test discoveryBootstrap"
```

  and append `&& pnpm kernel:discovery:test` to `kernel:full-key-free:test`.

- [ ] **Step 2: Run gate (a) aggregates** —
  `cargo test -p strata-kernel` and
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test`
  — expected: PASS.

- [ ] **Step 3: Run the full chain** —
  `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test`. This is
  long (tens of minutes). This environment (Stably Orca) kills harness
  background tasks unpredictably: run it DETACHED (Node
  `spawn(..., { detached: true })` writing to a log file — there is no
  `setsid` binary on macOS) and watch the log with a persistent monitor,
  or run it in foreground with the maximum tool timeout and restart on
  harness kill. Expected: every stage green. Paste the tail of the log
  into the task record — evidence before assertions.

- [ ] **Step 4: Also run the workspace suite** —
  `PATH=/opt/homebrew/bin:$PATH pnpm -r test` — expected: PASS, no key
  needed.

- [ ] **Step 5: Record.** Append a decisions.md entry: B-1 landed — what
  shipped (four actions, collection contract, fail-closed projection,
  bootstrap gate); the documented `get_references` SUBTREE interpretation
  and why (references target name-identifier children — see this plan's
  header and the review archive); any divergences found during build (if
  none, say so); gate evidence (chain green, registration digest
  unchanged, tasks.ts untouched by any B-1 commit). Update
  `docs/product-roadmap.md` item B: B-1 complete, B-2 next. Do NOT edit
  `strata-design.md`.

- [ ] **Step 6: Commit**

```bash
git add package.json decisions.md docs/product-roadmap.md
git commit -m "chore(kernel): wire discovery-bootstrap gate into key-free chain; record B-1 close"
```

---

## Explicit non-goals (do not let them creep in)

- No `semantic_search`, no embeddings, no general file reads.
- No registered-fixture reader (`list_validation_fixtures` /
  `read_validation_fixture`) — B-2.
- No change to `inspect_nodes` semantics, including its Module-payload
  blanking and its relationships-over-bound failure.
- No change to validation profiles, `NodeBridgeConfig::tsc_only`,
  diagnostics taxonomy, or anything else on the B-2 surface.
- No edits to `packages/live-compare/src/tasks.ts` (and no commit stages
  it), registered prompts, or the Phase-6 manifest schema.
- No SQLite-product-path changes (`packages/store` discovery stays as-is;
  the kernel mirrors its semantics, it does not refactor them).
- No structural insert/delete/move work (item C).

## Self-Review (v2)

Spec coverage re-checked after integrating the review: collection contract
(Tasks 1/3/4), path projection incl. absolute + escape fail-closed with
raw-segment validation (Tasks 2/4), honest `list_module_declarations`
semantics with product-parity export tests (Tasks 1/3), scoped find +
replaced 64-failure (Tasks 1/3), subtree reference paging (Tasks 1/3/4 +
documented interpretation), client wrappers with full call-site sweep
(Task 5), tool surface incl. fake-client and snapshot-test updates (Task
6), gate (b) as an acceptance test with pinned digest, per-walk generation
checks, and exact reference equality (Task 7), gate (c) full chain (Task
8). Compile-state audit: Task 1 ends with the crate compiling and both
fixture suites green (truthful `has_more: false`); Task 2 is additive; Task
3 carries the signature change plus its session call site in one commit;
Task 4 adds only new arms. All three v1 open questions are resolved per the
review (fixed 64-page find; required limit; no second service run).
