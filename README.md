# pi-self-harness

Experimental, eval-driven harness optimization for [Pi](https://pi.dev).

This project turns historical development work and established benchmarks into reproducible tasks, evaluates bounded model-specific harness profiles, and records auditable results. It does not train model weights or permit candidates to rewrite trusted code.

## Status

Foundation only:

- repository inventory and safety metadata
- versioned task, suite, and profile schemas
- detached-worktree runner with isolated one-commit Git history to prevent future-patch leakage
- rootless Podman/Docker Linux executor with network-disabled agent containers
- host-side Pi/model credentials with container-routed read/write/edit/bash tools
- hidden verifier files injected only after the agent exits
- full Pi JSON trace plus compact turns/tools/errors/tokens/cost summary
- manifest validation, bounded diagnosis-evidence mining, tool-free declarative proposal generation, repeated suite execution, and matched profile comparison

Not implemented yet: remote Debian dispatch, hardened macOS isolation, multi-candidate search, statistical significance testing, automatic profile installation, or Terminal-Bench integration.

## Setup

```bash
npm install
npm run images        # OrbStack/Docker images for TypeScript and Go tasks
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

Run the same split and trial count for a frozen candidate, then compare the summaries:

```bash
npm run cli -- compare BASELINE-SUMMARY.json CANDIDATE-SUMMARY.json
```

Comparison requires matching model, split, tasks, and trial numbers. Any correctness regression fails. Diagnosis candidates must show a material improvement; validation and locked-test comparisons require no regression. Three trials are required by default. These deterministic gates are preliminary and do not yet provide statistical significance testing.

## Mine and propose

Only diagnosis summaries may feed proposal generation. Mining selects bounded agent-visible metrics and final reports; verifier output is excluded.

```bash
npm run cli -- mine DIAGNOSIS-SUMMARY.json --output evidence.json
npm run cli -- propose evidence.json \
  --id candidate-one \
  --model provider/proposal-model \
  --thinking high \
  --output profiles/candidate-one.yaml
```

The proposer is a separate ephemeral Pi process with no tools, resources, context files, or project trust. It also receives structured rejected hypotheses from [`config/proposal-history.yaml`](config/proposal-history.yaml) to discourage repeating known regressions. Its output must pass the profile schema and may contain only one appended instruction or a subset of the four container-routed tools. Generated profiles are never installed or promoted automatically; review one before evaluation.

## Evaluation strategy

- Personal historical tasks are the primary optimization target.
- Terminal-Bench 2.0 provides an external regression anchor.
- Safety tasks are a hard gate.
- Live Pi sessions provide weakness-mining evidence but are not directly comparable evaluations.
- Diagnosis, validation, and truly locked test splits remain separate.

Preliminary candidate outcomes and rejection rationale are recorded in [`docs/experiments.md`](docs/experiments.md).
