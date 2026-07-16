# Deterministic Full Key-Free Acceptance Design

**Status:** Approved and implemented (projection-bounded PASS 2026-07-15)

**Date:** 2026-07-15

**Parent design:** `docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`

**Gap analysis:** `docs/superpowers/specs/2026-07-15-deterministic-full-key-free-gap-analysis.md`

## Goal

Approve the Phase-6 deterministic key-free coordination gate by proving that multiple independent clients can submit real typed operations through the Rust/redb kernel and reach one shared green `examples/medium` codebase without branches, worktrees, text merges, direct canonical-storage access, model keys, or live-model spend.

This design closes the twelve acceptance rows already approved in the parent design. It does not redesign the coordinator or broaden the supported operation set.

## Approved corpus boundary

Candidate execution and TypeScript validation use the exact ingest-derived `src/**` projection fixed by the newest `decisions.md` entry. Full-snapshot semantic analysis remains part of the evidence, including the asserted 1,282/614 full and 1,203/592 projected node/reference counts and the four known excluded cross-boundary `formatTimestamp` reference sources.

The final evidence must say “projection-bounded candidate validation.” It must not claim full-fixture candidate validation.

## Architecture

### Independent clients

The acceptance harness represents clients as independent logical actors with distinct actor IDs, event cursors, change-set IDs, and submissions. A client may call only the public kernel coordination surface:

- create or reopen the kernel through the production Node bridge constructor;
- begin a change set;
- add typed intents;
- submit the change set;
- claim ready work;
- execute a claim through the sealed production executor;
- read and acknowledge events.

There is no new production `Client` abstraction and no network layer. Direct Rust callers are sufficient to test the authority boundary because they have no redb handle or canonical-storage mutation API.

### Layered acceptance, one named gate

One monolithic test would obscure which invariant failed and would require test-only paths to impersonate crash boundaries. Instead, the named gate combines three evidence layers:

1. **Real bridge multi-client acceptance:** real `examples/medium` snapshots, production Node semantic facts, sealed candidate execution, Rust scope/policy/containment, and redb publication.
2. **Exhaustive kernel durability/recovery:** every existing authorized redb boundary, stale fences/epochs, scheduler recovery, replay equivalence, event cursors, and deterministic interleavings.
3. **Normal-build authority sealing:** compile-fail and runtime tests with test features disabled.

Every one of the twelve rows has one primary owning test. Supporting tests may remain lower-level where the property is operation-independent, but a thin real-bridge join is required wherever Node execution could invalidate the inference.

### Determinism

- No model or API key.
- No wall-clock sleeps for ordering or fairness.
- Logical ticks drive age, leases, and retries.
- Fixed actor IDs, request IDs, change-set IDs, attempt IDs, and fixture paths.
- A bounded one-shot worker per semantic/candidate request.
- Child-process crash tests use enumerated authorized boundaries and deterministic exit points.
- Final snapshots, histories, event streams, and digests are compared canonically.

## Real multi-client scenarios

### Disjoint progress and lost-update protection

Two clients submit disjoint renames from G0. Both become independently runnable. Publish them in both possible orders in separate deterministic cases. The final graph contains both changes, is green, records two Rust-owned operations/generations, and contains no dirty or overwritten state.

### Same-symbol decision ordering

Two clients submit `User -> Account` and `User -> Customer`. FIFO ordering allows only the first claim. After publication, the second client receives bounded fresh state and `IntentNeedsDecision`; the kernel never silently applies the stale lexical intent to `Account`.

### Real inferred overlap

One client renames `User`; another adds a parameter to `greet`, whose existing signature references `User`. The clients provide only declaration/function IDs and typed intent parameters. Rust derives the reference-mediated reservation overlap from Node semantic facts. The overlap is visible before mutation, so only one claim is executable and no dirty candidate is published.

### Dynamic scope expansion

Retain the G+1 fixture: an `add_parameter` waits while another client publishes a disjoint generation containing a new callsite. Fresh analysis expands the callsite closure, invalidates the old scope fingerprint, requeues before mutation, and later publishes a candidate that updates the declaration and every callsite exactly once.

### Starvation freedom

An older wide rename is held behind one overlapping predecessor while newer work arrives. Deterministic scheduler ticks allow disjoint work to pass. Once the predecessor clears, newer overlapping tickets cannot repeatedly bypass the aged rename. Production Node analysis supplies all scopes; the test supplies no resource keys.

### Restart, stale authority, and event resumption

Persist a queued real operation, an unacknowledged event, and a held claim. Drop and reopen the kernel. The queued ticket and cursor survive. The old claim is rejected by service epoch/fence before publication. A newly claimed attempt completes through the normal executor, and duplicate delivery of the prior event is harmless.

### Only-green-together change set

Use two ordered intents in one change set:

1. `rename_symbol(User, Account)`
2. `add_parameter(greet, account: Account, defaultValue: "undefined as never")`

The add-parameter intent alone is a required negative control: `Account` is unresolved on G0 and candidate TypeScript validation fails with no publication. The grouped change first establishes the renamed type and then adds the parameter in one scratch transaction. It must validate, publish one Rust generation, create one aggregate operation with two ordered intent results, and expose no intermediate canonical state.

If this fixture cannot meet those assertions with the existing operation semantics, the implementation stops rather than adding an operation class or weakening validation.

## Crash and replay proof

The exhaustive existing crash matrix remains authoritative for “every redb boundary.” Add one bridge-integrated child-process case that:

1. opens the projected real graph;
2. submits and claims a real typed operation through the kernel;
3. builds the candidate through the bounded worker;
4. terminates at an authorized publication boundary;
5. reopens without Node when recovery should be storage-only;
6. observes either the complete old tuple or complete new tuple, never a mixture.

Replay evidence publishes at least two real bridge generations, crosses a snapshot boundary, publishes a later operation, reopens, and compares canonical node bytes, reference bytes, derived index bytes, operation order, generation, and digest. This test must use the same storage/replay implementation as production; no test-only reconstruction algorithm is allowed.

## Authority and test injection

Test-only hooks remain behind `coordination-test-api` or `redb-spike-api`. The named gate deliberately runs both feature-enabled correctness suites and a separate default-feature sealing suite. The default build must continue to reject:

- caller-supplied resource keys or reservations;
- external semantic providers or candidate builders;
- externally minted candidate envelopes/digests;
- publication hooks and failpoints;
- direct canonical graph or redb mutation;
- a Node request containing a redb path or coordination authority fields.

## Gate command and evidence artifact

Add one root command, `pnpm kernel:full-key-free:test`, that:

1. builds and tests `@strata/kernel-bridge`;
2. runs the dedicated real multi-client acceptance target with the required test features and worker path;
3. runs the complete Rust default, `coordination-test-api`, and `redb-spike-api` suites;
4. reruns normal-build authority sealing explicitly.

The completion artifact under `docs/spikes/` records the exact commands, test counts, boundary matrix, acceptance-row-to-test mapping, fixture counts, final digests, and any known unrelated baselines. The roadmap changes only after the command and all supporting suites pass.

## Alternatives considered

### Require every row to be one real Node end-to-end test

Rejected. Event cursor idempotence and redb atomicity are better proven exhaustively below the operation layer. Reimplementing those failure points through Node would add a second test-only publication path and weaken diagnostic precision.

### Accept the existing split evidence without real bridge joins

Rejected. The final claim concerns real independent clients and real typed operations. Synthetic semantic providers alone cannot prove that production Node facts preserve overlap, requeue, and aggregate-validation behavior.

### Expand candidate validation to the full 1,282-node snapshot

Rejected by the newest decision. That would fold a known corpus-validation limitation into the coordination gate. The exact source projection is sufficient for the authority and concurrency thesis and is frozen in deterministic tests.

## Completion criteria

The design passes only when all twelve rows have green named evidence and the aggregate assertions show:

- zero lost updates;
- zero dirty reads;
- zero partial commits at every authorized redb boundary;
- zero stale-fence or old-epoch publications;
- explicit ordering or `IntentNeedsDecision` for every overlap;
- independent progress for every disjoint scope;
- one shared green projection after all successful multi-client scenarios;
- no authority escape in the normal build.

Only then may the roadmap mark key-free acceptance complete. Live-model comparison remains a separate, later operator decision.
