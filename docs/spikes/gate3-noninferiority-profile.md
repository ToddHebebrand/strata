# Gate 3 — unkeyed noninferiority profile (kernel vs SQLite, key-free)

## Verdict: FAIL (measured LCB 12.8897 > 1.25)

## Provenance

- HEAD sha: `8e4f970459de34d28ece8dddcc6aa083a518d619` (dirty: false)
- Harness digest: `83a54a1441825f51c478e93eca4970acff0cfde930777a3fce0279f0807b2ba4`
- Daemon binary sha: `7047e1f009840f98caeb51e5a72cd8b3bc50b3ca9f8b77ddf37d1839bfab21db`
- OS: darwin 25.5.0 / CPU: Apple M4 Pro
- Node: v26.3.0 / Rust: rustc 1.89.0 (29483883e 2025-08-04)
- Schedule seed: 20260722200
- Metrics mode: timing:off;characterization:on
- Timestamp: 2026-07-22T16:07:03.687Z

### medium

Corpus: digest `b808cda8f020972643d62268e686e8322ef2130ed64abc90a0a8d430a82379e8`, 22 modules, 1 copy

Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):
- cold: seed 20260722200, N=12 (per arm), realized order BABABABAABBAABABBABAABBA
- warm: seed 20260722201, N=12 (per arm), realized order BABABAABBABAABBAABABBABA

| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| medium | cold | 12 | 2138.920ms | 487.877ms | 2360.430ms | 557.818ms | 4.2315 | 4.6379 | 3.9228 | FAIL |
| medium | warm | 12 | 2111.720ms | 324.351ms | 2235.558ms | 677.378ms | 3.3003 | 6.3694 | 3.2132 | FAIL |

Warm trend: firstHalfP95Ratio=3.3003, lastHalfP95Ratio=6.3355

| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 171737088 | 172965888 | 172965888 | yes | -1.0000 | no | INCONCLUSIVE |
| sqlite | 320520192 | 388546560 | 388546560 | yes | -1.0000 | no | INCONCLUSIVE |

Lifecycle-call parity: kernel=4, sqlite=4 (4-vs-4)

Server characterization (metrics-on, non-dispositive): submit p95=634.191ms, advance p95=1559.145ms, daemonRss=16089088B, workerRss=273055744B

### big1k

Corpus: digest `845af2a91899690e849cefb4e4cbdc93eb2926ba3e8fc58aac709a94b5a69401`, 1012 modules, 46 copies

Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):
- cold: seed 20260722210, N=8 (per arm), realized order ABBAABABBAABABAB
- warm: seed 20260722211, N=8 (per arm), realized order ABBAABABBABAABBA

| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| big1k | cold | 8 | 24242.671ms | 1842.011ms | 24528.271ms | 2003.132ms | 12.2450 | 12.8520 | 12.1529 | FAIL |
| big1k | warm | 8 | 24561.757ms | 1892.290ms | 25031.606ms | 1941.981ms | 12.8897 | 12.9553 | 12.8897 | FAIL |

Warm trend: firstHalfP95Ratio=12.8897, lastHalfP95Ratio=12.9416

| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 171737088 | 172965888 | 411123712 | yes | 194.8133 | no | INCONCLUSIVE |
| sqlite | 320520192 | 388546560 | 674365440 | yes | 5.2016 | no | FAIL |

Lifecycle-call parity: kernel=4, sqlite=4 (4-vs-4)

Server characterization (metrics-on, non-dispositive): submit p95=8982.346ms, advance p95=17386.343ms, daemonRss=174620672B, workerRss=508395520B

