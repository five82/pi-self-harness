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

## 2026-07-24: generated reactive validation-stop candidate

After three baseline diagnosis trials, the bounded proposer generated a reactive instruction: once validation fails solely because it tries to download tooling, do not retry or probe alternative installers, but continue distinct checks using available tools.

| Profile | Passed | Tool calls | Tool errors | Duration | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| `baseline` | 6/6 | 115 | 6 | 593.1 s | $1.7881 |
| generated candidate | 6/6 | 114 | 5 | 575.8 s | $1.9229 |

The candidate reduced one tool call, one tool error, and aggregate duration by 2.9%, but increased reported cost by 7.5%. The comparison gate rejected it before validation because cost exceeded the 5% regression limit. Its profile was removed and its hypothesis recorded in `config/proposal-history.yaml`.

## 2026-07-24: bounded proposer smoke test

The tool-free proposer received the one-trial diagnosis snapshot and declined to generate a profile because the evidence was insufficient. It used 840 input tokens, 49 output tokens, cost $0.0057, and produced no candidate file. This is the intended conservative behavior before repeated diagnosis evidence exists.

## Excluded infrastructure-invalid runs

- An early `flyer-spindle-api-config` baseline attempt mounted `/tmp` as non-executable, causing hidden Go test binaries to fail after a successful agent run. The mount now permits execution while retaining `nosuid` and `nodev`.
- The first `reel-swap-growth-pressure` baseline attempt produced a correct patch, but the hidden verifier rejected its valid choice to retain the two-argument helper signature with an unnamed swap parameter. The verifier now behaviorally covers both historical and compatible signatures. It fails at the base revision, passes at the historical fix, and passes the rejected run's patch. A fresh baseline run passed.
- The first `infra-stable-release-discovery` attempt exposed a container-name truncation bug: a long run ID was sliced to a name beginning with `-`, which Docker rejected. Container names now keep a `psh-` prefix and include a stable hash within the length limit.
- Two subsequent Infra attempts produced semantically valid alternatives that exposed underspecified helper names and verifier assumptions about normalized versus raw npm metadata. The task now states its public API and the verifier accepts both command-side extraction and in-helper JSON parsing. It still fails at the base revision, passes at the historical fix, and a fresh baseline run passed.
