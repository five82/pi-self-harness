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

## 2026-07-25: expanded diagnosis baseline and batch proposal

The three-task diagnosis split completed three baseline trials: 9/9 passed, with $4.3672 reported cost, 226 tool calls, and 17 tool errors. A single tool-free batch proposal call then produced three distinct hypotheses targeting validation-wrapper bootstrapping, duplicate package-script flags, and ad hoc import probes. The batch mechanism was validated, but no candidate was retained or evaluated pending a bounded screening workflow.

## 2026-07-25: task-corpus expansion

Four more historical replays were added and their boundaries were validated before model evaluation:

- Diagnosis `flyer-structured-api-errors`: base `8ee85b65cbd38d4856818e19328d90b34b0ed44c`, historical fix `6a8befc54fbd6e291379347b27732173f96f615a`. The hidden verifier requires bounded structured API error handling; it fails at the base and passes at the fix.
- Validation `infra-global-pi-context`: base `5e1edacb12b83ee2e4d999e92bb48f90de969ab3`, historical fix `13f6e1d510d8de06cfb4590e891b2387724d6d0b`. The hidden verifier covers shared resource content, Linux ownership, current-user behavior, and explicit host wiring; it fails at the base and passes at the fix.
- Diagnosis `reel-ivf-peak-second-bitrate`: base `917df9aa3b3dc7d20957192b0f8111094d1b5c0c`, historical fix `2da7cf81fa89c0b34d782bd354ecacc464f3e27d`. Its file-scoped verifier exercises rational PTS bucketing and malformed IVF input without native libraries or encoding; it fails at the base and passes at the fix.
- Diagnosis `projectgm-prehalftime-clock-strategy`: base `1437ccdc167afb71e339c538b4cf5fc830339a25`, historical fix `ef0dedb2cb531224c9f96dc45adfbdb5d7b17b8d`. Its verifier covers first-half pass mix, pace, kneeling, and endgame-only boundaries; it fails at the base and passes at the fix.

The personal suite now has six diagnosis, two validation, and one locked-test task. Subsequent GPT-5.6 Sol smoke runs produced valid solutions for all additions; verifier-generalization details are recorded under excluded runs below.

## 2026-07-25: six-task diagnosis baseline

Three GPT-5.6 Sol/high-thinking trials produced 18 semantically valid solutions, with $8.7453 reported cost, 394 tool calls, and 28 tool errors. The original suite artifact reports 17/18 because trial 2 of `infra-stable-release-discovery` used the npm registry's dist-tags endpoint, while the hidden verifier supplied only the different `/npm/latest` response shape. The implementation passes the corrected behavior-based verifier, as does the historical fix; the base still fails. The original result remains unchanged for audit and must not be mined as a genuine correctness failure.

## 2026-07-25: six-task candidate screening

Corrected diagnosis evidence produced three new hypotheses. The guessed-path candidate was rejected before evaluation because it repeated prior configured-runner and reactive missing-tool ideas. One valid shared-baseline screen evaluated the remaining two across all six diagnosis tasks; all 18 attempts passed.

| Candidate hypothesis | Passed | Cost delta | Duration delta | Tool-call delta | Tool-error delta | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Inspect unfamiliar static API signatures | 6/6 | +10.3% | +10.3% | +5 | +1 | drop: efficiency |
| Make optional zero-match searches non-failing | 6/6 | -5.6% | -4.8% | -18 | +2 | drop: tool-error guardrail |

No candidate was retained. The second hypothesis had meaningful cost and tool-call improvements, but added one failed import probe and one overlapping-edit failure. These were not zero-match searches, yet one screening trial is insufficient reason to waive the fixed aggregate tool-error guardrail.

## 2026-07-25: shared-baseline candidate screening

After the OrbStack-interrupted attempt was discarded, one valid diagnosis-only screen compared the three generated candidates against a shared baseline. All 12 task/profile attempts completed; baseline passed 3/3.

| Candidate hypothesis | Passed | Cost delta | Duration delta | Tool-error delta | Outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| Preflight validation wrappers | 3/3 | +34.1% | +12.1% | -2 | drop: efficiency |
| Avoid duplicate package-script flags | 2/3 | +17.1% | +1.7% | -1 | drop: correctness |
| Prefer configured project runners | 3/3 | +14.3% | -5.9% | +1 | drop: efficiency |

No candidate was retained for a full experiment. Their hypotheses and rejection reasons were added to `config/proposal-history.yaml`.

## 2026-07-24: generated reactive validation-stop candidate

After three baseline diagnosis trials, the bounded proposer generated a reactive instruction: once validation fails solely because it tries to download tooling, do not retry or probe alternative installers, but continue distinct checks using available tools.

| Profile | Passed | Tool calls | Tool errors | Duration | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| `baseline` | 6/6 | 115 | 6 | 593.1 s | $1.7881 |
| generated candidate | 6/6 | 114 | 5 | 575.8 s | $1.9229 |

The candidate reduced one tool call, one tool error, and aggregate duration by 2.9%, but increased reported cost by 7.5%. The comparison gate rejected it before validation because cost exceeded the 5% regression limit. Its profile was removed and its hypothesis recorded in `config/proposal-history.yaml`.

## 2026-07-24: bounded proposer smoke test

The tool-free proposer received the one-trial diagnosis snapshot and declined to generate a profile because the evidence was insufficient. It used 840 input tokens, 49 output tokens, cost $0.0057, and produced no candidate file. This is the intended conservative behavior before repeated diagnosis evidence exists.

## Excluded invalid runs

- An early `flyer-spindle-api-config` baseline attempt mounted `/tmp` as non-executable, causing hidden Go test binaries to fail after a successful agent run. The mount now permits execution while retaining `nosuid` and `nodev`.
- The first `reel-swap-growth-pressure` baseline attempt produced a correct patch, but the hidden verifier rejected its valid choice to retain the two-argument helper signature with an unnamed swap parameter. The verifier now behaviorally covers both historical and compatible signatures. It fails at the base revision, passes at the historical fix, and passes the rejected run's patch. A fresh baseline run passed.
- The first `infra-stable-release-discovery` attempt exposed a container-name truncation bug: a long run ID was sliced to a name beginning with `-`, which Docker rejected. Container names now keep a `psh-` prefix and include a stable hash within the length limit.
- Two subsequent Infra attempts produced semantically valid alternatives that exposed underspecified helper names and verifier assumptions about normalized versus raw npm metadata. The task now states its public API and the verifier accepts both command-side extraction and in-helper JSON parsing. It still fails at the base revision, passes at the historical fix, and a fresh baseline run passed.
- Trial 2 of the six-task diagnosis baseline exposed another npm-response-shape assumption in `infra-stable-release-discovery`: the implementation correctly read the stable `latest` value from the registry dist-tags endpoint instead of the historical `/npm/latest` endpoint. The verifier now supplies endpoint-appropriate metadata. It fails at the base, passes the historical fix, and passes the trial's alternate patch. The suite artifact's 17/18 raw result is retained but its failure is excluded from correctness evidence.
- The first expanded batch proposal completed at the provider but was reported as empty because its large JSON event exceeded the process tail buffer. Process output streams are now flushed before return and proposal traces are summarized from the complete JSONL artifact; the rerun generated three valid candidates.
- The first three-candidate screening run was interrupted when OrbStack was closed. Four Pi Extensions attempts had run; all subsequent Flyer and Infra attempts failed at executor startup. Its ranking is invalid and ignored. Screening now aborts on the first detected container-runtime or executor failure and marks the artifact invalid rather than comparing infrastructure failures as candidate outcomes.
- The first `flyer-structured-api-errors` baseline used a valid 64 KiB error-body cap, while the hidden verifier silently required at most 8 KiB. The verifier now accepts bounds through 64 KiB plus an overflow byte and still rejects unbounded reads. The original patch and a fresh baseline pass the corrected verifier.
- Two `infra-global-pi-context` baselines produced valid alternatives with different operation/resource names and ownership parameter shapes. The hidden verifier initially encoded the historical names, then one alternative signature. It now discovers the one shared operation from explicit host wiring and checks behavior across supported signatures. The base still fails; the historical fix and both baseline patches pass.
