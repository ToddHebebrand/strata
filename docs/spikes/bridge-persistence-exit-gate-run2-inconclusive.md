# Gate 3 — unkeyed noninferiority profile (kernel vs SQLite, key-free)

## Verdict: INCONCLUSIVE (measured UCB 1.2527)

## Provenance

- HEAD sha: `d53b7252007536dca363c5a171ec8f1615c4efbf` (dirty: false)
- Harness digest: `5d4cd586f30636e47ba8e318a35ef7dd6b473573893372b81134d31a1a96d863`
- Daemon binary sha: `f2d0e2826a2b062a76fb65f0f0608e0b25f28501d5ce7ffe1dc66ff47ec9a26a`
- OS: darwin 25.6.0 / CPU: Apple M4 Pro
- Node: v26.5.0 / Rust: rustc 1.89.0 (29483883e 2025-08-04)
- Schedule seed: 20260722200
- Metrics mode: timing:off;characterization:on
- Timestamp: 2026-07-31T18:20:09.780Z

### medium

Corpus: digest `b808cda8f020972643d62268e686e8322ef2130ed64abc90a0a8d430a82379e8`, 22 modules, 1 copy

Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):
- cold: seed 20260722200, N=24 (per arm), realized order BABABABAABBAABABBABAABBABAABBAABABABBABABAABBABA
- warm: seed 20260722201, N=24 (per arm), realized order BABABAABBABAABBAABABBABAABABABBABABAABABABABBABA

| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| medium | cold | 24 | 786.384ms | 649.235ms | 1407.867ms | 1545.224ms | 0.9111 | 1.6564 | 0.6708 | INCONCLUSIVE |
| medium | warm | 24 | 487.890ms | 548.280ms | 941.438ms | 839.999ms | 1.1208 | 1.4882 | 0.6726 | INCONCLUSIVE |

Warm trend: firstHalfP95Ratio=1.1687, lastHalfP95Ratio=1.1208

| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 0 | 295305216 | 295305216 | yes | -1.0000 | no | PASS |
| sqlite | 280297472 | 399949824 | 399949824 | yes | -1.0000 | no | PASS |

Lifecycle-call parity: kernel=4, sqlite=4 (4-vs-4)

Server characterization (metrics-on, non-dispositive): submit p95=904.583ms, advance p95=2291.623ms, daemonRss=11943936B, workerRss=245121024B

### big1k

Corpus: digest `845af2a91899690e849cefb4e4cbdc93eb2926ba3e8fc58aac709a94b5a69401`, 1012 modules, 46 copies

Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):
- cold: seed 20260722210, N=8 (per arm), realized order ABBAABABBAABABAB
- warm: seed 20260722211, N=8 (per arm), realized order ABBAABABBABAABBA

| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| big1k | cold | 8 | 3303.547ms | 2753.230ms | 4536.361ms | 5947.137ms | 0.7628 | 1.2527 | 0.6139 | INCONCLUSIVE |
| big1k | warm | 8 | 3743.461ms | 5303.122ms | 4421.650ms | 7243.273ms | 0.6104 | 0.6831 | 0.5853 | PASS |

Warm trend: firstHalfP95Ratio=0.5970, lastHalfP95Ratio=0.6770

| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 0 | 295305216 | 956874752 | yes | -1.0000 | no | PASS |
| sqlite | 280297472 | 399949824 | 646955008 | yes | -1.0000 | no | PASS |

Lifecycle-call parity: kernel=4, sqlite=4 (4-vs-4)

Server characterization (metrics-on, non-dispositive): submit p95=3269.440ms, advance p95=8302.257ms, daemonRss=204406784B, workerRss=472104960B

