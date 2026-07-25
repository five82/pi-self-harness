# Design

## Goal

Empirically improve model-specific Pi harness profiles for five82's development work without allowing the model to rewrite trusted runtime or evaluator code.

The system optimizes harness configuration, not model weights or Pi core. Pi is an immutable, versioned dependency: this project never patches, forks, or carries private changes to Pi itself.

## Evaluation layers

1. **Personal replay suite** — primary optimization target, built from historical work in Spindle, Flyer, Reel, Infra, Pi Extensions, ProjectGM, zbot, and encodescripts.
2. **Established benchmark** — Terminal-Bench 2.0 regression anchor.
3. **Safety suite** — hard gates for filesystem boundaries, secrets, infrastructure, services, real media, and evaluator integrity.
4. **Live traces** — weakness-mining evidence only. Unrepeated live tasks are not a promotion gate.

Use diagnosis, validation, and locked-test splits. The locked test is run only after a harness is frozen. The paper's “held-out” split is used during promotion and is therefore treated here as validation, not test.

## Trusted boundary

Candidate profiles may eventually change only declared fields such as:

- appended model instructions
- exact-command retry limits
- tool-error recovery nudges
- exploration/tool-budget nudges
- optional active tools

Candidates may not change:

- evaluator or verifier logic
- task manifests or hidden tests
- permissions or safety middleware
- credentials
- repository instructions
- Pi core or other engine source

The runner currently supports appended instructions and a subset of the four container-routed tools. Candidate profiles cannot load extensions or add capabilities. Runtime middleware candidates would require a separately designed trusted boundary.

### Pi extension boundary

All runtime and tool behavior changes must use Pi's public extension APIs. They must never require a Pi fork or modification to Pi's installed source.

The existing `extension/container-tools.ts` is trusted evaluator infrastructure: it replaces the four filesystem/shell operations with container-routed implementations while leaving Pi and model credentials on the host. `extension/harbor-tools.ts` preserves the same boundary for established benchmarks: a fixed external Harbor agent owns a private Unix socket and invokes `BaseEnvironment`; the Pi subprocess and credentials remain on the host. Future tool experiments must be implemented as similarly reviewed extension variants. A candidate profile may eventually select only an opaque, allowlisted variant ID; it may not provide code, a module path, or an extension to load.

“Trusted variant” means its code is human-reviewed, tested, frozen before the evaluation, stored outside the agent-visible worktree, and fingerprinted in result artifacts. The evaluated model and proposal model cannot edit it. A successful variant may be made available from the separate `pi-extensions` package rather than Pi core, but availability is not global activation.

Improvement claims are scoped to the exact provider/model, thinking level, Pi version, profile, and evaluation suite. A promoted instruction or extension variant remains enabled only for the model combinations that passed promotion. Other models retain their existing behavior. A variant may become a general default only after separate cross-model evaluation.

## Run lifecycle

1. Resolve an immutable base revision.
2. Create a detached temporary worktree, replace its shared Git metadata with a new one-commit repository, and thereby hide later history and golden patches from the agent.
3. Run optional trusted setup. Container setup may use network access.
4. Start an ephemeral Pi JSON run with explicit model/profile settings. For Linux tasks, Pi remains on the host while read/write/edit/bash are routed into a capability-dropped container with network disabled by default.
5. Capture the complete agent patch before hidden verifier files are injected.
6. Run the verifier in the same task environment after the agent exits.
7. Save trace, patch, stderr, verifier logs, and structured result under `.runs/`.
8. Restore worktree metadata and remove the worktree unless preservation was requested.

Pi resource discovery is disabled during runs. Repository `AGENTS.md`/`CLAUDE.md` context remains active because it is part of real development behavior. The container-routing extension is trusted evaluator infrastructure, not candidate-controlled configuration.

## Reverification

Verifier corrections do not justify silently rewriting historical artifacts or paying for another model run. The `reverify` command reconstructs the recorded source revision in a fresh worktree, reruns trusted setup, applies the captured pre-verifier patch, injects the current hidden assets, and executes only the current verifier. Container reverification requires the original image digest; local reverification requires an explicit unsandboxed-verifier acknowledgement.

Each result is append-only and records hashes of the original result, captured patch, task manifest, verifier command/assets, and container image. The original result and suite summary remain unchanged. Weakness mining accepts explicitly named, hash-validated reverifications and records the resulting verdict overrides in its evidence; it never discovers or applies them implicitly.

## Executors and safety

### Linux container

The primary executor uses rootless Podman or Docker. The Pi/model process and credentials stay on the host. A mandatory extension routes the built-in read, write, edit, and bash tools into the container, which receives only the detached worktree and a run-local cache. The agent container drops Linux capabilities, enables `no-new-privileges`, and has no network by default. Setup may run in a separate networked container before the restricted agent container starts.

Candidate profiles cannot supply or load executable extensions. Container profiles are currently limited to enabling a subset of the four extension-routed built-in tools. Allowlisted tool-variant selection is a future feature; today there is one trusted container-tool implementation.

This materially isolates tools but is not a proof-grade sandbox: the container image and runtime are trusted dependencies, bind-mounted workspace writes reach the host worktree, and container-runtime vulnerabilities remain possible.

### Terminal-Bench through Harbor

The regression subset pins both the Terminal-Bench 2.0 source revision and a compatible Harbor revision. A trusted materialization step copies only named tasks, records source/materialized hashes, and adds an explicit no-network agent-phase policy without changing instructions, solutions, or verifiers. Harbor builds and verifies the benchmark normally. Host Pi loads only the reviewed bridge extension; profile files remain strictly declarative and are fingerprinted in Harbor metadata.

The benchmark task and verifier assets stay on the host side of Harbor's environment boundary. Pi starts from an empty host directory with context/resource discovery disabled, so it cannot inspect the benchmark checkout, solutions, tests, active repository, or future Git history. Only the four selected tool operations reach the task container. Terminal-Bench output is held out from diagnosis/proposal evidence until a candidate is frozen. Comparison rejects incomplete or errored Harbor jobs, execution-identity/task-checksum mismatches, any per-task mean-reward regression, and excessive aggregate cost. Interleaved Harbor orchestration and a combined cross-suite promotion command are not yet implemented.

### macOS local

Xcode/zbot tasks currently execute locally because Xcode cannot run in a Linux container. A detached worktree protects the active checkout but Bash still has the user's permissions. The CLI therefore requires `--allow-unsandboxed-agent` for local runs. Use only reviewed historical tasks until a dedicated macOS user or VM executor exists.

Remote dispatch to the Debian 13 host is a later orchestration layer; the same repository can already run container tasks directly when cloned there.

## Weakness mining and proposals

Only diagnosis summaries can become proposal evidence. The miner copies aggregate correctness, cost, duration, tool counts, bounded agent-visible tool-error text, stop reason, and bounded final agent reports. It does not copy verifier commands, injected assets, or verifier output.

A separate ephemeral Pi process receives that evidence plus structured prior rejections from `config/proposal-history.yaml`, with tools, resource discovery, context files, sessions, and project trust disabled. It can propose one profile or a batch of up to five distinct hypotheses in one call. Responses are parsed as declarative profiles. Unknown fields, executable extensions, unsupported tools, mixed prompt/tool changes, oversized instructions, and direct diagnosis-task references are rejected. A generated profile remains an untrusted candidate requiring review and evaluation.

## Experiments and promotion policy

Up to five reviewed candidates can first pass through a bounded diagnosis-only screen. It runs one shared baseline and one trial per candidate, rotating execution order by task. Candidates with correctness or efficiency-guardrail regressions are dropped; remaining candidates need a measured improvement signal and are ranked by correctness, tool errors, cost, and duration. Screening artifacts fingerprint every profile and are marked `screeningOnly`; retention means only that a candidate may enter a full experiment. Suite, screening, and experiment orchestration abort on detected container-runtime failures so infrastructure outages cannot become candidate scores.

Baseline and finalist trials should be run through the interleaved experiment command. For each task/trial pair it alternates which profile runs first, reducing order and transient-provider effects. Experiment artifacts fingerprint both profile files and retain exact execution order. Comparison reports deterministic 95% paired-bootstrap intervals for per-pair cost, duration, and tool-error changes. Until the corpus is larger, fixed correctness and efficiency thresholds remain the promotion gates and intervals are supporting uncertainty evidence.

A candidate should be promoted only when:

- personal validation improves beyond measured run variance
- no repository materially regresses
- Terminal-Bench does not materially regress
- safety tasks all pass
- cost and tool-use budgets remain acceptable
- merged candidates are re-evaluated as a combined profile

Scores remain stratified by repository and task category; a single aggregate score must not hide an Infra, Reel, or safety regression.
