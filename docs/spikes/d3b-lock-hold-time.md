# D-3b global-lock hold-time measurement

Date: 2026-08-24

## Question and fixed workload

Does wait or hold time on the three D-2 global locks become a material ten-client bottleneck? Each actor warmed 10 cycles, the sample counters were reset at a global idle barrier, then each recorded 50 cycles of `hello`, `list_modules(limit=64)`, `find_declarations(User, interface)`, and `read_events(afterSequence=0, limit=64)`. Arms used `examples/medium`, tsc-only validation, persistent bridge off, identical actor IDs, three repetitions, and N=1/N=10.

## Result

Yes, for `session.journal` and `session.audit`; no for `session.protocol`. At N=10, conservative (maximum across three repetitions) wait p99 was 67.708–79.308 ms for the journal and 80.675–217.495 ms for audit, while protocol wait p99 remained at or below 0.005 ms. The current D-3b arm showed the worst audit tail (217.495 ms p99) and journal tail (79.308 ms p99). This fixed workload therefore resolves the debt as a real serialization bottleneck; it does not establish a universal performance claim. D-3b records a follow-up and does not optimize it.

All 18 mmap artifacts had `dropped=0`. Recorded counts were exactly 400/200/200 (protocol/journal/audit) for N=1 and 4000/2000/2000 for N=10. Clock-wrapper overhead is retained per run in the JSON and is not subtracted from any distribution.

## Conservative maxima across three repetitions (milliseconds)

| arm | N | lock | wait p95 | wait p99 | hold p95 | hold p99 |
|---|---:|---|---:|---:|---:|---:|
| pre-d2-v1 | 1 | session.protocol | 0.001 | 0.001 | 0.041 | 0.055 |
| pre-d2-v1 | 1 | session.journal | 0.000 | 0.000 | 4.988 | 6.508 |
| pre-d2-v1 | 1 | session.audit | 0.000 | 0.001 | 4.971 | 5.564 |
| pre-d2-v1 | 10 | session.protocol | 0.001 | 0.001 | 0.039 | 0.050 |
| pre-d2-v1 | 10 | session.journal | 63.825 | 67.708 | 9.931 | 12.326 |
| pre-d2-v1 | 10 | session.audit | 64.261 | 80.675 | 9.946 | 12.395 |
| post-d2-v2 | 1 | session.protocol | 0.001 | 0.001 | 0.040 | 0.056 |
| post-d2-v2 | 1 | session.journal | 0.000 | 0.001 | 5.254 | 6.723 |
| post-d2-v2 | 1 | session.audit | 0.000 | 0.000 | 4.950 | 5.524 |
| post-d2-v2 | 10 | session.protocol | 0.001 | 0.001 | 0.034 | 0.050 |
| post-d2-v2 | 10 | session.journal | 63.968 | 76.391 | 10.822 | 12.513 |
| post-d2-v2 | 10 | session.audit | 67.981 | 73.342 | 10.754 | 13.147 |
| d3b | 1 | session.protocol | 0.001 | 0.002 | 0.039 | 0.053 |
| d3b | 1 | session.journal | 0.000 | 0.000 | 5.381 | 7.444 |
| d3b | 1 | session.audit | 0.000 | 0.000 | 5.434 | 7.954 |
| d3b | 10 | session.protocol | 0.001 | 0.005 | 0.061 | 0.119 |
| d3b | 10 | session.journal | 62.903 | 79.308 | 22.237 | 44.758 |
| d3b | 10 | session.audit | 147.077 | 217.494 | 24.029 | 45.884 |

## Raw per-run tails (milliseconds)

### session.protocol

| arm | N | rep | wait p95 | wait p99 | wait max | hold p95 | hold p99 | hold max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pre-d2-v1 | 1 | 1 | 0.001 | 0.001 | 0.001 | 0.033 | 0.036 | 0.058 |
| pre-d2-v1 | 1 | 2 | 0.001 | 0.001 | 0.001 | 0.034 | 0.037 | 0.050 |
| pre-d2-v1 | 1 | 3 | 0.001 | 0.001 | 0.003 | 0.041 | 0.055 | 0.073 |
| pre-d2-v1 | 10 | 1 | 0.001 | 0.001 | 0.092 | 0.037 | 0.047 | 0.354 |
| pre-d2-v1 | 10 | 2 | 0.001 | 0.001 | 0.133 | 0.039 | 0.050 | 0.240 |
| pre-d2-v1 | 10 | 3 | 0.001 | 0.001 | 0.166 | 0.035 | 0.046 | 0.189 |
| post-d2-v2 | 1 | 1 | 0.001 | 0.001 | 0.001 | 0.031 | 0.037 | 0.055 |
| post-d2-v2 | 1 | 2 | 0.001 | 0.001 | 0.001 | 0.033 | 0.035 | 0.052 |
| post-d2-v2 | 1 | 3 | 0.001 | 0.001 | 0.005 | 0.040 | 0.056 | 0.086 |
| post-d2-v2 | 10 | 1 | 0.001 | 0.001 | 0.174 | 0.034 | 0.050 | 2.419 |
| post-d2-v2 | 10 | 2 | 0.001 | 0.001 | 0.161 | 0.034 | 0.042 | 0.114 |
| post-d2-v2 | 10 | 3 | 0.001 | 0.001 | 0.155 | 0.033 | 0.039 | 0.080 |
| d3b | 1 | 1 | 0.001 | 0.001 | 0.010 | 0.039 | 0.045 | 0.058 |
| d3b | 1 | 2 | 0.001 | 0.002 | 0.034 | 0.039 | 0.053 | 0.160 |
| d3b | 1 | 3 | 0.001 | 0.001 | 0.002 | 0.034 | 0.037 | 0.046 |
| d3b | 10 | 1 | 0.001 | 0.001 | 0.237 | 0.036 | 0.063 | 0.158 |
| d3b | 10 | 2 | 0.001 | 0.001 | 0.159 | 0.047 | 0.080 | 0.291 |
| d3b | 10 | 3 | 0.001 | 0.005 | 1.865 | 0.061 | 0.119 | 1.298 |

### session.journal

| arm | N | rep | wait p95 | wait p99 | wait max | hold p95 | hold p99 | hold max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pre-d2-v1 | 1 | 1 | 0.000 | 0.000 | 0.000 | 4.875 | 4.970 | 6.739 |
| pre-d2-v1 | 1 | 2 | 0.000 | 0.000 | 0.000 | 4.779 | 4.870 | 5.054 |
| pre-d2-v1 | 1 | 3 | 0.000 | 0.000 | 0.001 | 4.988 | 6.508 | 8.007 |
| pre-d2-v1 | 10 | 1 | 59.643 | 63.844 | 80.790 | 9.921 | 10.893 | 33.196 |
| pre-d2-v1 | 10 | 2 | 63.825 | 67.708 | 75.951 | 9.931 | 12.326 | 26.897 |
| pre-d2-v1 | 10 | 3 | 62.030 | 65.749 | 94.111 | 9.549 | 10.840 | 15.130 |
| post-d2-v2 | 1 | 1 | 0.000 | 0.000 | 0.001 | 4.766 | 4.909 | 4.962 |
| post-d2-v2 | 1 | 2 | 0.000 | 0.000 | 0.000 | 4.860 | 5.231 | 5.931 |
| post-d2-v2 | 1 | 3 | 0.000 | 0.001 | 0.001 | 5.254 | 6.723 | 44.970 |
| post-d2-v2 | 10 | 1 | 53.849 | 62.424 | 68.426 | 10.005 | 11.027 | 16.140 |
| post-d2-v2 | 10 | 2 | 62.001 | 76.391 | 127.249 | 10.822 | 12.513 | 32.678 |
| post-d2-v2 | 10 | 3 | 63.968 | 66.947 | 69.048 | 9.989 | 10.469 | 14.160 |
| d3b | 1 | 1 | 0.000 | 0.000 | 0.000 | 5.303 | 7.444 | 11.711 |
| d3b | 1 | 2 | 0.000 | 0.000 | 0.001 | 5.381 | 6.042 | 13.777 |
| d3b | 1 | 3 | 0.000 | 0.000 | 0.000 | 4.978 | 5.854 | 8.928 |
| d3b | 10 | 1 | 52.816 | 54.944 | 68.813 | 9.933 | 11.984 | 23.088 |
| d3b | 10 | 2 | 62.014 | 65.941 | 69.986 | 9.306 | 10.307 | 20.345 |
| d3b | 10 | 3 | 62.903 | 79.308 | 286.252 | 22.237 | 44.758 | 114.906 |

### session.audit

| arm | N | rep | wait p95 | wait p99 | wait max | hold p95 | hold p99 | hold max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pre-d2-v1 | 1 | 1 | 0.000 | 0.000 | 0.000 | 4.733 | 4.878 | 5.827 |
| pre-d2-v1 | 1 | 2 | 0.000 | 0.000 | 0.000 | 4.834 | 5.061 | 5.140 |
| pre-d2-v1 | 1 | 3 | 0.000 | 0.001 | 0.001 | 4.971 | 5.564 | 9.083 |
| pre-d2-v1 | 10 | 1 | 62.462 | 65.054 | 70.793 | 9.946 | 11.187 | 34.005 |
| pre-d2-v1 | 10 | 2 | 64.261 | 80.675 | 90.113 | 9.938 | 12.395 | 26.791 |
| pre-d2-v1 | 10 | 3 | 23.215 | 48.868 | 54.319 | 9.690 | 11.032 | 19.194 |
| post-d2-v2 | 1 | 1 | 0.000 | 0.000 | 0.001 | 4.950 | 5.429 | 7.065 |
| post-d2-v2 | 1 | 2 | 0.000 | 0.000 | 0.001 | 4.668 | 4.871 | 9.216 |
| post-d2-v2 | 1 | 3 | 0.000 | 0.000 | 0.002 | 4.907 | 5.524 | 22.655 |
| post-d2-v2 | 10 | 1 | 64.349 | 67.280 | 105.957 | 10.010 | 11.776 | 15.463 |
| post-d2-v2 | 10 | 2 | 67.981 | 73.342 | 142.731 | 10.754 | 13.147 | 33.234 |
| post-d2-v2 | 10 | 3 | 38.797 | 41.408 | 44.667 | 9.967 | 10.574 | 14.174 |
| d3b | 1 | 1 | 0.000 | 0.000 | 0.000 | 5.434 | 7.954 | 27.853 |
| d3b | 1 | 2 | 0.000 | 0.000 | 0.001 | 5.305 | 5.591 | 10.967 |
| d3b | 1 | 3 | 0.000 | 0.000 | 0.000 | 4.847 | 5.370 | 5.524 |
| d3b | 10 | 1 | 42.659 | 54.278 | 80.099 | 9.935 | 12.892 | 26.949 |
| d3b | 10 | 2 | 65.796 | 69.315 | 134.197 | 9.457 | 11.015 | 22.340 |
| d3b | 10 | 3 | 147.077 | 217.494 | 334.311 | 24.029 | 45.884 | 101.850 |

## Provenance and limitation

- Source refs: `db15b38` (protocol v1), `0e07f60` (protocol v2), and `6ff5bf3` (D-3b instrumentation head).
- Sampler commit: `6ff5bf3`; byte-identical `lock_metrics.rs` SHA-256 on all arms: `d2906395ac076b0da5bcacd8a46273ef208c821360fb064c885b457e391be3af`.
- Runtime: v26.7.0; rustc 1.89.0 (29483883e 2025-08-04); Apple M4 Pro; Darwin arm64.
- The planned `cherry-pick -n` did not apply cleanly because D-3b added drain fields beside the instrumented fields after both historical refs. Work stopped, then only version-specific wiring conflicts in `main.rs`/`session.rs` were resolved; the sampler source remained byte-identical. This is a methodology limitation, disclosed rather than hidden.
- Raw summaries, no-op timing, dirty-state disclosure, and exact provenance are in [the JSON artifact](d3b-lock-hold-time.json).
