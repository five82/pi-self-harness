# Experiments

## 2026-07-24: explicit offline-environment instruction

A preliminary GPT-5.6 Sol candidate told the agent not to run network-dependent checks and to use their offline components instead. It was evaluated once on `flyer-spindle-api-config` against the baseline profile.

| Profile | Passed | Agent time | Tool calls | Tool errors | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| `baseline` | yes | 156.4 s | 29 | 1 | $0.4868 |
| `gpt-5.6-sol-offline-aware` | yes | 177.5 s | 34 | 4 | $0.5602 |

The candidate was rejected before repeated or held-out evaluation. It caused the model to probe several unavailable offline tools after the repository's CI wrapper attempted a download, increasing time, errors, and cost without changing correctness. The candidate profile was removed; run artifacts remain locally for audit.

## 2026-07-24: baseline suite snapshot

One GPT-5.6 Sol/high-thinking baseline pass established the expanded corpus:

| Split | Passed | Tasks | Reported cost |
| --- | ---: | ---: | ---: |
| diagnosis | yes | 2/2 | $0.6308 |
| validation | yes | 1/1 | $0.2403 |

This single sample is a smoke baseline, not promotion evidence. The locked ProjectGM task was historically verified against its base and fix revisions but was intentionally not evaluated before a candidate is frozen.

## Excluded infrastructure-invalid runs

- An early `flyer-spindle-api-config` baseline attempt mounted `/tmp` as non-executable, causing hidden Go test binaries to fail after a successful agent run. The mount now permits execution while retaining `nosuid` and `nodev`.
- The first `reel-swap-growth-pressure` baseline attempt produced a correct patch, but the hidden verifier rejected its valid choice to retain the two-argument helper signature with an unnamed swap parameter. The verifier now behaviorally covers both historical and compatible signatures. It fails at the base revision, passes at the historical fix, and passes the rejected run's patch. A fresh baseline run passed.
