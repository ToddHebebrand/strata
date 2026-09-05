# Restart verification — 2026-09-05

Starting revision: `55d1c4a0deb29b02b72c01db8d774e84b517b684` on `main`.
The 62 previously local commits were pushed to `origin/main` before work.
Local `.claude/` settings/worktrees were preserved and added to `.gitignore`.
No application code, test thresholds, or runtime defaults changed.

Environment: macOS, Node v22.23.2, pnpm 10.26.2, rustc 1.89.0.

## Initial checks

- `pnpm install --frozen-lockfile`: passed. pnpm warned about the existing
  ingest/store workspace cycle and ignored esbuild's installation script.
- `pnpm -r build`: passed.
- `pnpm -r test`: failed only the live-compare persistent-worker RSS guard;
  the other nine tested packages passed. live-compare: 259 passed, one failed,
  two skipped. RSS baseline 409,468,928 bytes, tail 516,145,152 bytes,
  limit 470,889,267.2 bytes. This is a failed measurement, not proof of a leak.
- `pnpm kernel:full-key-free:test`: stopped at four feature-enabled lifecycle
  tests because the launched daemon rejected test-only command-line flags.

The first workspace/kernel runs overlapped. That was not an isolated test
configuration: `live-compare/tests/serviceHarness.ts` builds the default daemon
into the same Cargo target path that lifecycle tests launch via
`CARGO_BIN_EXE_strata-kernel-service`. A feature-build overwrite is a plausible
explanation for the flag failures; it needs an isolated rerun, not a code fix
based on the contaminated run. Overlap also prevents attributing the RSS
failure to a stable idle-machine condition.

Initial raw logs are local, ephemeral files:
`/tmp/strata-restart-workspace-tests.log` and
`/tmp/strata-restart-kernel-tests.log`.

## Isolated follow-up

The isolated chain passed the Rust feature matrices (including all 25
feature-enabled lifecycle tests), API sealing, parity, observability, recorded
performance regression checks, and persistence oracle. It stopped at the RSS
guard again: baseline 408,715,264 bytes, tail 523,010,048 bytes, limit
470,022,553.6 bytes. Eight other tests in that file passed. The failure therefore
reproduces without the competing workspace suite; its cause remains unproven.
Do not call the full key-free gate green or loosen the threshold to close it.

Isolated log: `/tmp/strata-restart-kernel-isolated.log`. The two downstream
stages passed separately: `pnpm kernel:discovery:test` (one test) and
`pnpm kernel:behavioral:test` (two product-parity tests plus three kernel
behavioral/timeout tests). No live model calls or paid benchmarks were run.

Next diagnostic task: explain persistent-worker RSS growth under the pinned
twelve-mutation protocol, preserving the existing acceptance and opt-in default.
Any fix or changed measurement contract needs its own evidence and review.

Follow-up completed: [memory diagnosis](2026-09-05-memory-diagnosis.md).
Longer natural-GC and unchanged-corpus controls support collectable allocation
growth rather than an identified accumulating worker graph. The existing guard
still fails; redesign approval is pending, not inferred from that diagnosis.

## Design handoff

The [Item E scenario](../superpowers/specs/2026-09-05-item-e-scratch-to-release-design.md)
is independently reviewed as a draft, with exact fixtures and schedule
qualification still pending. Its creation requirements scope Item C; neither
implementation nor live-run approval is implied. README and roadmap status
were reconciled with the recorded B/D closures and existing product findings.
