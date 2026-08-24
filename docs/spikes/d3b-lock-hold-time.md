# D-3b global-lock hold-time measurement

Date: 2026-08-24

## Question and fixed workload

Does wait or hold time on the three D-2 global locks become a material ten-client bottleneck? Each actor warmed 10 cycles, all actors were released from one explicit common barrier, the sample counters were reset at a global idle barrier, then all actors were again released together to record 50 cycles of `hello`, `list_modules(limit=64)`, `find_declarations(User, interface)`, and `read_events(afterSequence=0, limit=64)`. Arms used `examples/medium`, tsc-only validation, persistent bridge off, identical actor IDs, three repetitions, and N=1/N=10. Reply and handshake shapes were validated strictly; any dropped mmap sample invalidated a run.

## Result

Yes, for `session.journal` and `session.audit`; no for `session.protocol`. At N=10, conservative (maximum across three repetitions) wait p99 was 65.153–70.936 ms for the journal and 100.734–112.464 ms for audit, while protocol wait p99 remained at or below 0.003 ms. The corrected common-barrier rerun therefore preserves the decision: journal and audit serialization are real bottlenecks in this workload; protocol locking is negligible. This does not establish a universal performance claim. D-3b records a follow-up and does not optimize it.

All 18 mmap artifacts had `dropped=0`. Recorded counts were exactly 400/200/200 (protocol/journal/audit) for N=1 and 4000/2000/2000 for N=10. Clock-wrapper overhead is retained per run in the JSON and is not subtracted from any distribution.

## Conservative maxima across three repetitions (milliseconds)

| arm | N | lock | wait p95 | wait p99 | hold p95 | hold p99 |
|---|---:|---|---:|---:|---:|---:|
| pre-d2-v1 | 1 | session.protocol | 0.002 | 0.003 | 0.088 | 0.116 |
| pre-d2-v1 | 1 | session.journal | 0.001 | 0.001 | 6.961 | 9.094 |
| pre-d2-v1 | 1 | session.audit | 0.001 | 0.001 | 7.667 | 10.883 |
| pre-d2-v1 | 10 | session.protocol | 0.002 | 0.003 | 0.086 | 0.120 |
| pre-d2-v1 | 10 | session.journal | 56.681 | 65.153 | 11.610 | 15.432 |
| pre-d2-v1 | 10 | session.audit | 82.126 | 111.068 | 11.984 | 15.860 |
| post-d2-v2 | 1 | session.protocol | 0.001 | 0.002 | 0.051 | 0.064 |
| post-d2-v2 | 1 | session.journal | 0.000 | 0.001 | 5.768 | 8.216 |
| post-d2-v2 | 1 | session.audit | 0.001 | 0.001 | 5.738 | 9.645 |
| post-d2-v2 | 10 | session.protocol | 0.001 | 0.002 | 0.070 | 0.113 |
| post-d2-v2 | 10 | session.journal | 59.953 | 67.069 | 10.150 | 13.031 |
| post-d2-v2 | 10 | session.audit | 73.411 | 112.464 | 10.493 | 14.171 |
| d3b | 1 | session.protocol | 0.001 | 0.001 | 0.073 | 0.088 |
| d3b | 1 | session.journal | 0.000 | 0.000 | 5.415 | 5.840 |
| d3b | 1 | session.audit | 0.001 | 0.001 | 5.343 | 5.745 |
| d3b | 10 | session.protocol | 0.001 | 0.002 | 0.076 | 0.128 |
| d3b | 10 | session.journal | 64.064 | 70.936 | 10.057 | 11.686 |
| d3b | 10 | session.audit | 73.791 | 100.734 | 10.130 | 13.642 |

## Raw per-run tails (milliseconds)

### session.protocol

| arm | N | rep | wait p95 | wait p99 | wait max | hold p95 | hold p99 | hold max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pre-d2-v1 | 1 | 1 | 0.002 | 0.003 | 0.009 | 0.087 | 0.112 | 0.131 |
| pre-d2-v1 | 1 | 2 | 0.002 | 0.003 | 0.016 | 0.088 | 0.114 | 0.208 |
| pre-d2-v1 | 1 | 3 | 0.002 | 0.002 | 0.003 | 0.088 | 0.116 | 0.363 |
| pre-d2-v1 | 10 | 1 | 0.001 | 0.001 | 0.090 | 0.056 | 0.089 | 0.343 |
| pre-d2-v1 | 10 | 2 | 0.001 | 0.002 | 0.224 | 0.065 | 0.105 | 0.344 |
| pre-d2-v1 | 10 | 3 | 0.002 | 0.003 | 0.226 | 0.086 | 0.120 | 0.350 |
| post-d2-v2 | 1 | 1 | 0.001 | 0.001 | 0.004 | 0.051 | 0.064 | 0.109 |
| post-d2-v2 | 1 | 2 | 0.001 | 0.001 | 0.002 | 0.047 | 0.057 | 0.093 |
| post-d2-v2 | 1 | 3 | 0.001 | 0.002 | 0.023 | 0.050 | 0.054 | 0.070 |
| post-d2-v2 | 10 | 1 | 0.001 | 0.001 | 0.218 | 0.070 | 0.113 | 0.634 |
| post-d2-v2 | 10 | 2 | 0.001 | 0.002 | 0.159 | 0.056 | 0.095 | 0.275 |
| post-d2-v2 | 10 | 3 | 0.001 | 0.001 | 0.169 | 0.061 | 0.111 | 0.290 |
| d3b | 1 | 1 | 0.001 | 0.001 | 0.002 | 0.065 | 0.088 | 0.298 |
| d3b | 1 | 2 | 0.001 | 0.001 | 0.003 | 0.073 | 0.081 | 0.192 |
| d3b | 1 | 3 | 0.001 | 0.001 | 0.002 | 0.062 | 0.079 | 0.140 |
| d3b | 10 | 1 | 0.001 | 0.001 | 0.174 | 0.064 | 0.105 | 0.240 |
| d3b | 10 | 2 | 0.001 | 0.002 | 0.549 | 0.076 | 0.128 | 2.171 |
| d3b | 10 | 3 | 0.001 | 0.001 | 0.466 | 0.056 | 0.092 | 0.170 |

### session.journal

| arm | N | rep | wait p95 | wait p99 | wait max | hold p95 | hold p99 | hold max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pre-d2-v1 | 1 | 1 | 0.001 | 0.001 | 0.001 | 6.961 | 8.784 | 10.590 |
| pre-d2-v1 | 1 | 2 | 0.001 | 0.001 | 0.001 | 5.624 | 7.489 | 44.699 |
| pre-d2-v1 | 1 | 3 | 0.001 | 0.001 | 0.001 | 6.916 | 9.094 | 27.007 |
| pre-d2-v1 | 10 | 1 | 33.204 | 62.008 | 78.574 | 11.610 | 15.432 | 36.005 |
| pre-d2-v1 | 10 | 2 | 44.630 | 57.539 | 75.413 | 10.972 | 13.188 | 19.754 |
| pre-d2-v1 | 10 | 3 | 56.681 | 65.153 | 75.474 | 11.161 | 14.144 | 52.812 |
| post-d2-v2 | 1 | 1 | 0.000 | 0.001 | 0.001 | 5.240 | 7.099 | 9.618 |
| post-d2-v2 | 1 | 2 | 0.000 | 0.001 | 0.001 | 5.768 | 8.216 | 10.295 |
| post-d2-v2 | 1 | 3 | 0.000 | 0.000 | 0.001 | 5.277 | 7.318 | 9.817 |
| post-d2-v2 | 10 | 1 | 20.523 | 49.961 | 67.649 | 9.828 | 12.486 | 45.012 |
| post-d2-v2 | 10 | 2 | 59.851 | 67.069 | 91.650 | 10.150 | 13.031 | 96.330 |
| post-d2-v2 | 10 | 3 | 59.953 | 61.902 | 64.675 | 9.793 | 10.972 | 28.000 |
| d3b | 1 | 1 | 0.000 | 0.000 | 0.001 | 5.415 | 5.599 | 5.982 |
| d3b | 1 | 2 | 0.000 | 0.000 | 0.001 | 5.366 | 5.840 | 9.497 |
| d3b | 1 | 3 | 0.000 | 0.000 | 0.001 | 5.069 | 5.356 | 6.778 |
| d3b | 10 | 1 | 64.064 | 70.936 | 73.833 | 9.841 | 11.152 | 37.230 |
| d3b | 10 | 2 | 46.701 | 55.843 | 73.099 | 10.057 | 11.686 | 39.077 |
| d3b | 10 | 3 | 39.825 | 55.620 | 71.620 | 9.040 | 10.109 | 15.057 |

### session.audit

| arm | N | rep | wait p95 | wait p99 | wait max | hold p95 | hold p99 | hold max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pre-d2-v1 | 1 | 1 | 0.001 | 0.001 | 0.001 | 7.667 | 8.729 | 9.486 |
| pre-d2-v1 | 1 | 2 | 0.001 | 0.001 | 0.001 | 6.925 | 10.883 | 22.340 |
| pre-d2-v1 | 1 | 3 | 0.001 | 0.001 | 0.001 | 6.857 | 9.646 | 24.369 |
| pre-d2-v1 | 10 | 1 | 82.126 | 111.068 | 183.615 | 11.984 | 15.860 | 43.930 |
| pre-d2-v1 | 10 | 2 | 73.010 | 82.391 | 142.617 | 11.482 | 14.082 | 17.897 |
| pre-d2-v1 | 10 | 3 | 71.975 | 94.933 | 145.307 | 11.878 | 15.013 | 36.889 |
| post-d2-v2 | 1 | 1 | 0.001 | 0.001 | 0.001 | 5.727 | 7.594 | 17.547 |
| post-d2-v2 | 1 | 2 | 0.000 | 0.001 | 0.001 | 5.738 | 9.645 | 25.868 |
| post-d2-v2 | 1 | 3 | 0.000 | 0.001 | 0.001 | 4.948 | 5.311 | 9.764 |
| post-d2-v2 | 10 | 1 | 69.970 | 107.409 | 135.183 | 10.007 | 13.978 | 45.240 |
| post-d2-v2 | 10 | 2 | 73.411 | 112.464 | 201.481 | 10.493 | 14.171 | 147.202 |
| post-d2-v2 | 10 | 3 | 69.456 | 81.143 | 147.410 | 9.910 | 12.443 | 27.799 |
| d3b | 1 | 1 | 0.001 | 0.001 | 0.013 | 5.343 | 5.745 | 25.096 |
| d3b | 1 | 2 | 0.001 | 0.001 | 0.001 | 5.224 | 5.647 | 5.902 |
| d3b | 1 | 3 | 0.001 | 0.001 | 0.001 | 5.288 | 5.721 | 6.799 |
| d3b | 10 | 1 | 69.152 | 87.929 | 182.867 | 9.704 | 12.873 | 35.097 |
| d3b | 10 | 2 | 73.791 | 99.569 | 151.860 | 10.130 | 13.642 | 31.636 |
| d3b | 10 | 3 | 66.773 | 100.734 | 127.034 | 9.333 | 11.835 | 16.049 |

## Provenance and limitation

- Source refs: `db15b38` (protocol v1), `0e07f60` (protocol v2), and `51d80aa` (review-corrected D-3b head).
- Sampler commit: `6ff5bf3`; byte-identical `lock_metrics.rs` SHA-256 on all arms: `d2906395ac076b0da5bcacd8a46273ef208c821360fb064c885b457e391be3af`.
- Runtime: v26.7.0; rustc 1.89.0 (29483883e 2025-08-04); Apple M4 Pro; Darwin arm64.
- The planned `cherry-pick -n` did not apply cleanly because D-3b added drain fields beside the instrumented fields after both historical refs. Work stopped, then only version-specific wiring conflicts in `main.rs`/`session.rs` were resolved; the sampler source remained byte-identical. This is a methodology limitation, disclosed rather than hidden.
- This artifact supersedes the earlier same-day capture: independent review exposed the missing explicit actor-release barrier and non-failing dropped-sample path, so all 18 arms were rerun after both were corrected.
- Raw summaries, no-op timing, dirty-state disclosure, and exact provenance are in [the JSON artifact](d3b-lock-hold-time.json).
