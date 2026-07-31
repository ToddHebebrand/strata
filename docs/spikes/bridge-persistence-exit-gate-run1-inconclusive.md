# Gate 3 — unkeyed noninferiority profile (kernel vs SQLite, key-free)

## Verdict: INCONCLUSIVE (measured UCB 1.4348)

## Provenance

- HEAD sha: `f87d5c29a31d037f1fd1221b67ab4da410965a7e` (dirty: false)
- Harness digest: `2661421e556bb395b012b1a3dc97521ef99a02c99aeb242ad2bd88a1e02a405f`
- Daemon binary sha: `f2d0e2826a2b062a76fb65f0f0608e0b25f28501d5ce7ffe1dc66ff47ec9a26a`
- OS: darwin 25.6.0 / CPU: Apple M4 Pro
- Node: v26.5.0 / Rust: rustc 1.89.0 (29483883e 2025-08-04)
- Schedule seed: 20260722200
- Metrics mode: timing:off;characterization:on
- Timestamp: 2026-07-31T18:08:54.552Z

### medium

Corpus: digest `b808cda8f020972643d62268e686e8322ef2130ed64abc90a0a8d430a82379e8`, 22 modules, 1 copy

Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):
- cold: seed 20260722200, N=12 (per arm), realized order BABABABAABBAABABBABAABBA
- warm: seed 20260722201, N=12 (per arm), realized order BABABAABBABAABBAABABBABA

| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| medium | cold | 12 | 1985.719ms | 1751.269ms | 4085.654ms | 2847.512ms | 1.4348 | 1.4348 | 1.1245 | INCONCLUSIVE |
| medium | warm | 12 | 615.076ms | 1313.408ms | 1754.453ms | 3327.394ms | 0.5273 | 0.7851 | 0.2933 | PASS |

Warm trend: firstHalfP95Ratio=0.6452, lastHalfP95Ratio=0.5273

| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 0 | 270827520 | 270827520 | yes | -1.0000 | no | PASS |
| sqlite | 288178176 | 372408320 | 372408320 | yes | -1.0000 | no | PASS |

Lifecycle-call parity: kernel=4, sqlite=4 (4-vs-4)

Server characterization (metrics-on, non-dispositive): submit p95=4757.706ms, advance p95=8606.230ms, daemonRss=11747328B, workerRss=247169024B

### big1k

Corpus: digest `845af2a91899690e849cefb4e4cbdc93eb2926ba3e8fc58aac709a94b5a69401`, 1012 modules, 46 copies

Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):
- cold: seed 20260722210, N=8 (per arm), realized order ABBAABABBAABABAB
- warm: seed 20260722211, N=8 (per arm), realized order ABBAABABBABAABBA

| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| big1k | cold | 8 | 3223.575ms | 5145.588ms | 5507.040ms | 8736.941ms | 0.6303 | 0.8661 | 0.4675 | PASS |
| big1k | warm | 8 | 3746.344ms | 5541.702ms | 5072.495ms | 7044.013ms | 0.7201 | 0.7488 | 0.6513 | PASS |

Warm trend: firstHalfP95Ratio=0.6990, lastHalfP95Ratio=0.7201

| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 0 | 270827520 | 960315392 | yes | -1.0000 | no | PASS |
| sqlite | 288178176 | 372408320 | 527417344 | yes | -1.0000 | no | PASS |

Lifecycle-call parity: kernel=4, sqlite=4 (4-vs-4)

Server characterization (metrics-on, non-dispositive): submit p95=3182.384ms, advance p95=9588.519ms, daemonRss=187957248B, workerRss=450396160B

