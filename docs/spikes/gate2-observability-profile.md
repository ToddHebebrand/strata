# Gate 2 — per-stage observability profile (kernel arm, T03, key-free)

| Category | Measured value | Source record |
| --- | --- | --- |
| Per-stage wall time (submit) | 1,213,415,584 ns | `request` (action=submit_change_set) |
| Per-stage wall time (advance, max) | 2,920,554,083 ns | `request` (action=advance_change_set) |
| Peak memory — daemon | 13,418,496 B | `request` (daemonPeakRssBytes, max across requests) |
| Peak memory — worker (max) | 249,397,248 B | `workerRun` (worker.peakRssBytes, max across runs) |
| Serialized snapshot bytes — seed | 238,640 B | `recovery` (cold) |
| Serialized snapshot bytes — worker request (analysis run) | 238,642 B | `workerRun` |
| Serialized snapshot bytes — restart recovery | 238,640 B | `recovery` (restart) |
| Node-worker starts | 6 | `workerRun` (record count) |
| SQLite hydration time (inside the worker, max) | 151,172,666 ns | `workerRun` (worker.hydrateNs) |
| Validation time (candidate tsc gate) | 785,893,750 ns | `workerRun` (phase=candidate, worker.validateNs) |
| redb publication time (persistence) | 34,144,875 ns | `request` (publication.persistenceNs) |
| redb publication — core graph record value bytes* | 13,048 B | `request` (publication.coreGraphRecordValueBytes) |
| Restart replay time | 15,734,292 ns | `recovery` (restart) |

\* `coreGraphRecordValueBytes` is the encoded value bytes of exactly the four
core graph records (operation + delta + ticket + event) written by the
publishing advance. It is NOT total transaction bytes and NOT physical redb
bytes on disk — see decisions.md / the gate-2 plan for the full-transaction
byte-accounting residual.
