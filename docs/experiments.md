# Experiments

## 2026-07-24: explicit offline-environment instruction

A preliminary GPT-5.6 Sol candidate told the agent not to run network-dependent checks and to use their offline components instead. It was evaluated once on `flyer-spindle-api-config` against the baseline profile.

| Profile | Passed | Agent time | Tool calls | Tool errors | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| `baseline` | yes | 156.4 s | 29 | 1 | $0.4868 |
| `gpt-5.6-sol-offline-aware` | yes | 177.5 s | 34 | 4 | $0.5602 |

The candidate was rejected before repeated or held-out evaluation. It caused the model to probe several unavailable offline tools after the repository's CI wrapper attempted a download, increasing time, errors, and cost without changing correctness. The candidate profile was removed; run artifacts remain locally for audit.

An earlier baseline attempt is excluded because the evaluator mounted `/tmp` as non-executable, causing hidden Go test binaries to fail after an otherwise successful agent run. The container mount now explicitly permits execution while retaining `nosuid` and `nodev`.
