# Gate 3 — unkeyed noninferiority profile (kernel vs SQLite, key-free)

## Verdict: INCONCLUSIVE (measured UCB 1.7837)

## Provenance

- HEAD sha: `f50cf6ea92a4651f4352232cc6bde5ab95a7aed3` (dirty: false)
- Harness digest: `5d4cd586f30636e47ba8e318a35ef7dd6b473573893372b81134d31a1a96d863`
- Daemon binary sha: `f2d0e2826a2b062a76fb65f0f0608e0b25f28501d5ce7ffe1dc66ff47ec9a26a`
- OS: darwin 25.6.0 / CPU: Apple M4 Pro
- Node: v26.5.0 / Rust: rustc 1.89.0 (29483883e 2025-08-04)
- Schedule seed: 20260722200
- Metrics mode: timing:off;characterization:on
- Timestamp: 2026-07-31T20:13:50.227Z

### medium

Corpus: digest `b808cda8f020972643d62268e686e8322ef2130ed64abc90a0a8d430a82379e8`, 22 modules, 1 copy

Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):
- cold: seed 20260722200, N=24 (per arm), realized order BABABABAABBAABABBABAABBABAABBAABABABBABABAABBABA
- warm: seed 20260722201, N=24 (per arm), realized order BABABAABBABAABBAABABBABAABABABBABABAABABABABBABA

| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| medium | cold | 24 | 440.390ms | 425.106ms | 867.071ms | 714.044ms | 1.2143 | 1.7837 | 0.9341 | INCONCLUSIVE |
| medium | warm | 24 | 270.713ms | 302.481ms | 311.094ms | 354.075ms | 0.8786 | 0.9793 | 0.8067 | PASS |

Warm trend: firstHalfP95Ratio=0.8067, lastHalfP95Ratio=0.8705

| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 0 | 380452864 | 380452864 | yes | -1.0000 | no | PASS |
| sqlite | 321126400 | 485785600 | 485785600 | yes | -1.0000 | no | PASS |

Lifecycle-call parity: kernel=4, sqlite=4 (4-vs-4)

Server characterization (metrics-on, non-dispositive): submit p95=523.339ms, advance p95=1137.770ms, daemonRss=13205504B, workerRss=273989632B

### big1k

Corpus: digest `845af2a91899690e849cefb4e4cbdc93eb2926ba3e8fc58aac709a94b5a69401`, 1012 modules, 46 copies

Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):
- cold: seed 20260722210, N=8 (per arm), realized order ABBAABABBAABABAB
- warm: seed 20260722211, N=8 (per arm), realized order ABBAABABBABAABBA

| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| big1k | cold | 8 | 2075.686ms | 1870.480ms | 2128.423ms | 1907.373ms | 1.1159 | 1.1304 | 1.0965 | PASS |
| big1k | warm | 8 | 2085.732ms | 1712.584ms | 2152.648ms | 1773.307ms | 1.2139 | 1.2396 | 1.2119 | PASS |

Warm trend: firstHalfP95Ratio=1.2119, lastHalfP95Ratio=1.2394

| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 0 | 380452864 | 991952896 | yes | -1.0000 | no | PASS |
| sqlite | 321126400 | 485785600 | 671842304 | yes | -1.0000 | no | PASS |

Lifecycle-call parity: kernel=4, sqlite=4 (4-vs-4)

Server characterization (metrics-on, non-dispositive): submit p95=1724.655ms, advance p95=4566.021ms, daemonRss=202604544B, workerRss=582287360B

