# pi-self-harness

Experimental, eval-driven harness optimization for [Pi](https://pi.dev).

This project turns historical development work and established benchmarks into reproducible tasks, evaluates bounded model-specific harness profiles, and records auditable results. It does not train model weights, modify or fork Pi core, or permit candidates to rewrite trusted code. Runtime changes use Pi's public extension APIs.

## Status

Foundation only:

- repository inventory and safety metadata
- versioned task, suite, and profile schemas
- detached-worktree runner with isolated one-commit Git history to prevent future-patch leakage
- rootless Podman/Docker Linux executor with network-disabled agent containers
- host-side Pi/model credentials with container-routed read/write/edit/bash tools
- hidden verifier files injected only after the agent exits
- full Pi JSON trace plus compact turns/tools/errors/tokens/cost summary
- manifest validation, bounded diagnosis-evidence mining, tool-free declarative proposal generation, shared-baseline candidate screening, repeated suite execution, and matched profile comparison
- pinned Terminal-Bench 2.0 subset support through Harbor's external-agent API

Not implemented yet: remote Debian dispatch, hardened macOS isolation, confidence-aware promotion gates, automatic profile installation, or interleaved Terminal-Bench execution.

## Setup

```bash
npm install
npm run images        # OrbStack/Docker images for TypeScript, Go, and Python tasks
npm test
npm run typecheck
```

## Inventory

```bash
npm run cli -- repositories
npm run cli -- validate
```

Configured repositories live in [`config/repositories.yaml`](config/repositories.yaml). Missing local repositories are reported but do not invalidate the inventory. [`suites/personal.yaml`](suites/personal.yaml) assigns task IDs to diagnosis, validation, and locked-test splits without exposing the split in task prompts.

## Run one task

Create a task as described in [`tasks/README.md`](tasks/README.md), then:

```bash
npm run cli -- run tasks/example.yaml \
  --profile profiles/baseline.yaml \
  --model provider/model \
  --thinking high
```

Artifacts are written under `.runs/<task>/<run-id>/`:

- `agent.jsonl`
- `agent.stderr.log`
- `agent.patch` and `agent-status.txt`
- setup and verification logs
- `result.json`

Container tasks require Docker (OrbStack on macOS) or Podman. Docker is the macOS default; Podman is the Linux default. Pi and its model credentials remain on the host; only tool operations execute in the container. Setup can use network access, while the agent container defaults to no network.

Native macOS tasks still require `--allow-unsandboxed-agent` because temporary worktrees do not provide OS isolation. Review [`docs/design.md`](docs/design.md) before executing them.

## Reverify a captured patch

When a trusted hidden verifier is corrected, reapply an existing `agent.patch` to its recorded source revision instead of rerunning the model:

```bash
npm run cli -- reverify .runs/TASK/RUN/result.json --task tasks/TASK.yaml
```

Reverification requires the original container image digest, reruns trusted setup, injects only the current hidden assets, and appends a fingerprinted result under the original run's `reverifications/` directory. It never changes the original result or suite summary. Native tasks require `--allow-unsandboxed-verifier`.

## Run a suite split

```bash
npm run cli -- suite suites/personal.yaml \
  --split diagnosis \
  --profile profiles/baseline.yaml \
  --model provider/model \
  --thinking high \
  --trials 3
```

Tasks run sequentially. Aggregate correctness, duration, tool use, and reported model cost are saved under `.runs/suites/<suite>/`.

For candidate evaluation, prefer an interleaved experiment. It alternates which profile runs first for each task/trial and fingerprints both profile files:

```bash
npm run cli -- experiment suites/personal.yaml \
  --split diagnosis \
  --baseline profiles/baseline.yaml \
  --candidate profiles/candidate-one.yaml \
  --model provider/model \
  --thinking high \
  --trials 3
```

Use `compare BASELINE-SUMMARY.json CANDIDATE-SUMMARY.json` for already completed matched runs. Comparison requires matching model, split, tasks, and trial numbers. Any correctness regression fails. Diagnosis candidates must show a material improvement; validation and locked-test comparisons require no regression. Three trials are required by default. Reports include deterministic 95% paired-bootstrap intervals for cost, duration, and tool-error deltas; current promotion gates remain conservative fixed thresholds while the corpus is small.

## Mine and propose

Only diagnosis summaries may feed proposal generation. Mining selects bounded agent-visible metrics and final reports; verifier output is excluded.

```bash
npm run cli -- mine DIAGNOSIS-SUMMARY.json \
  --reverifications REVERIFICATION-RESULT.json \
  --output evidence.json
npm run cli -- propose evidence.json \
  --id candidate-one \
  --model provider/proposal-model \
  --thinking high \
  --output profiles/candidate-one.yaml

npm run cli -- propose-batch evidence.json \
  --prefix candidate \
  --count 3 \
  --model provider/proposal-model \
  --output-directory profiles
```

Batch proposal uses one model call and may conservatively return fewer candidates. The proposer is a separate ephemeral Pi process with no tools, resources, context files, or project trust. It also receives structured rejected hypotheses from [`config/proposal-history.yaml`](config/proposal-history.yaml) to discourage repeating known regressions. Its output must pass the profile schema and may contain only one appended instruction or enable a subset of the four container-routed tools. Generated profiles cannot supply executable extension code. Tool behavior currently has one trusted implementation; future tool variants must be prebuilt, human-reviewed Pi extensions selected only through allowlisted IDs. Generated profiles are never installed or promoted automatically; review one before evaluation.

Screen up to five reviewed candidates with one shared baseline trial:

```bash
npm run cli -- screen suites/personal.yaml \
  --baseline profiles/baseline.yaml \
  --candidates profiles/candidate-1.yaml,profiles/candidate-2.yaml \
  --model provider/model \
  --thinking high \
  --retain 1
```

Screening runs only the diagnosis split, rotates profile order across tasks, fingerprints every profile, and ranks candidates using correctness followed by tool errors, cost, and duration. A candidate must avoid the comparison guardrails and show a measured improvement signal to be retained. Screening is explicitly preliminary: retained candidates still require the full interleaved three-trial experiment before validation.

## Terminal-Bench regression subset

The trusted Harbor adapter runs Pi on the host and forwards only `read`, `bash`, `edit`, and `write` over a mode-0600 Unix socket to Harbor's `BaseEnvironment`. Model credentials never enter task containers. The materializer pins five Terminal-Bench 2.0 tasks and adds only `[agent].network_mode = "no-network"`; source and materialized task hashes are recorded.

```bash
# Use the revisions in benchmarks/terminal-bench-2/subset.json.
python integrations/harbor/prepare_terminal_bench.py \
  --source /path/to/terminal-bench-2 \
  --target /tmp/pi-terminal-bench-2

cd /path/to/harbor
PYTHONPATH=/path/to/pi-self-harness uv run harbor run \
  --path /tmp/pi-terminal-bench-2 \
  --agent integrations.harbor.pi_host_agent:PiHostAgent \
  --model provider/model \
  --agent-kwarg thinking=high \
  --agent-kwarg profile_path=/path/to/pi-self-harness/profiles/baseline.yaml \
  --n-concurrent 1 \
  --jobs-dir /path/to/pi-self-harness/.runs/terminal-bench \
  --yes
```

Keep the Harbor and dataset checkouts at the recorded revisions. Run baseline and frozen candidate as separate jobs with identical task, model, thinking, and Harbor settings. Then require no per-task reward regression and bounded aggregate cost:

```bash
npm run cli -- terminal-bench-compare \
  .runs/terminal-bench/BASELINE-JOB \
  .runs/terminal-bench/CANDIDATE-JOB \
  --max-cost-regression 0.10 \
  --output .runs/terminal-bench/comparison.json
```

The comparison rejects incomplete/errored jobs, mismatched task checksums or execution identities, any per-task mean-reward regression, and cost increases over the configured limit. Do not expose benchmark results to proposal generation before the candidate is frozen. Interleaved Harbor execution and a combined cross-suite promotion command remain future work.

## Evaluation strategy

- Personal historical tasks are the primary optimization target.
- Terminal-Bench 2.0 provides an external regression anchor.
- Safety tasks are a hard gate.
- Live Pi sessions provide weakness-mining evidence but are not directly comparable evaluations.
- Diagnosis, validation, and truly locked test splits remain separate.
- Promotion is model-specific by default. Adding a variant to `pi-extensions` makes it available, not active for untested models; broader defaults require cross-model evaluation.

Preliminary candidate outcomes and rejection rationale are recorded in [`docs/experiments.md`](docs/experiments.md).
