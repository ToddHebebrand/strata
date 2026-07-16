# Task 12 report — final evidence and containment review correction

## Evidence commit

Task 12 recorded the bounded two-operation PASS in commit `efa0cd5`, including
the spike report, the sole roadmap checkbox change, the source-projection
decision entry, and the default-feature guard for the failure-matrix target.

## Final review correction

Whole-branch review found that `materialized_identifier_children` trusted a
proposed parent when exempting an existing Identifier node and edge from the
inferred write set. The exact malicious regression places existing
`other-direct` under validation-only `non-writable`, reserves the old parent,
new writable parent, source, and target, then proposes reparenting that same ID
into `writable` plus an edge upsert.

### RED

```text
cargo test -p strata-kernel --lib existing_identifier_cannot_gain_write_authority_by_reparenting_into_a_writable_statement -- --nocapture
```

Exit 101: `unwrap_err()` received `Ok(())`, proving the authority bypass.

### Fix and GREEN

- Existing node upserts derive eligibility from the current record and require
  current/proposed kind `Identifier`, equal parent, and equal child index.
  Payload mutation remains allowed.
- Genuinely absent Identifier IDs derive eligibility from the proposed record,
  preserving add-parameter materialization.
- Existing reference sources and all deletes derive identity from current
  state; only an absent reference source may use its matching new Identifier
  upsert.

The clean analyzer group passed 3/3. The feature real-worker suite passed 11/11,
including G1 add-parameter publication and claim-time scope expansion.

## Fresh verification

- failure matrix: 1/1 PASS, 63.56 s total (51.95 s test)
- `pnpm kernel:bridge:test`: 71/71 TypeScript + 3/3 real worker PASS, 37.35 s
- feature real-worker acceptance: 11/11 PASS, 43.70 s
- default Rust: PASS, 68.35 s; library 16 passed/1 ignored
- coordination-feature Rust: PASS, 145.32 s; library 16 passed/1 ignored
- redb-feature Rust: PASS, 157.64 s; library 19 passed/1 ignored
- `cargo fmt --all -- --check`: PASS, 0.85 s
- strict all-target/all-feature Clippy: PASS, 13.86 s
- no-default compile: PASS, 3.25 s

No EPIPE, 5-second rename timeout, or 30-second Node timeout occurred. The
existing TypeScript baselines and source-projection limitation are unchanged.
