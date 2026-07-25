#!/usr/bin/env -S node --experimental-strip-types

import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";
import { loadProfile, loadRepositoryConfig, loadSuite, loadTask } from "./config.ts";
import { compareSuiteRuns } from "./comparison.ts";
import { buildExperimentPlan, experimentSummaryPaths, type ExperimentExecution, type ExperimentSummary } from "./experiment.ts";
import { buildWeaknessEvidence, extractToolErrorEvidence, type ToolErrorEvidence, type WeaknessEvidence } from "./mining.ts";
import {
  buildProposalPiArgs,
  buildProposalPrompt,
  formatProfile,
  parseProposalHistory,
  parseProposedProfile,
} from "./proposal.ts";
import { runProcess } from "./process.ts";
import { evaluate } from "./runner.ts";
import { summarizeTraceText } from "./trace.ts";
import type { EvaluationResult, HarnessProfile } from "./types.ts";
import {
  summarizeSuite,
  suiteTaskResult,
  taskIdsForSplit,
  type SuiteRunSummary,
  type SuiteSplit,
  type SuiteTaskResult,
} from "./suite.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORIES = join(ROOT, "config", "repositories.yaml");
const DEFAULT_PROPOSAL_HISTORY = join(ROOT, "config", "proposal-history.yaml");

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg.includes("=")) {
      const [name, ...rest] = arg.slice(2).split("=");
      flags.set(name, rest.join("="));
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      index++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { positional, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function yamlFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && [".yaml", ".yml"].includes(extname(entry.name)))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function repositoriesPath(args: ParsedArgs): string {
  return resolve(flag(args, "repositories") ?? DEFAULT_REPOSITORIES);
}

function usage(): string {
  return `pi-self-harness

Commands:
  repositories [--repositories PATH]
      Show configured repositories and local availability.

  validate [--repositories PATH]
      Validate repository, profile, and task manifests.

  run TASK.yaml --profile PROFILE.yaml --model PROVIDER/MODEL [options]
      Run one task in a detached worktree and save artifacts under .runs/.

  suite SUITE.yaml --split diagnosis|validation|test --profile PROFILE.yaml --model PROVIDER/MODEL [options]
      Run one suite split sequentially and write an aggregate summary.

  experiment SUITE.yaml --split SPLIT --baseline PROFILE.yaml --candidate PROFILE.yaml --model PROVIDER/MODEL [options]
      Run an interleaved repeated baseline/candidate experiment and compare it.

  compare BASELINE-SUMMARY.json CANDIDATE-SUMMARY.json [--minimum-trials N] [--output PATH]
      Compare paired suite runs and produce a bounded promotion recommendation.

  mine DIAGNOSIS-SUMMARY.json [--output PATH]
      Extract bounded, agent-visible weakness evidence from diagnosis results.

  propose EVIDENCE.json --id ID --model PROVIDER/MODEL --output PROFILE.yaml [--history PATH] [options]
      Ask a tool-free Pi process for one bounded declarative candidate profile.

Run options:
  --thinking LEVEL
  --pi-command PATH
  --runs-directory PATH
  --trials N                 Suite default 1; experiment default 3.
  --proposal-timeout SECONDS Proposal timeout; default 300.
  --keep-worktree
  --allow-unsandboxed-agent   Required acknowledgement for local (non-container) tasks.
`;
}

async function showRepositories(args: ParsedArgs) {
  const config = loadRepositoryConfig(repositoriesPath(args));
  for (const repository of config.repositories) {
    const available = existsSync(repository.path) ? "available" : "missing";
    const platform = [repository.executor?.os, repository.executor?.arch].filter(Boolean).join("/") || "any";
    const executor = repository.executor?.type ?? "task/default";
    console.log(
      `${repository.id.padEnd(16)} ${available.padEnd(10)} ${executor.padEnd(12)} ${platform.padEnd(16)} ${repository.path}`,
    );
  }
}

async function validate(args: ParsedArgs) {
  const config = loadRepositoryConfig(repositoriesPath(args));
  if (existsSync(DEFAULT_PROPOSAL_HISTORY)) parseProposalHistory(await readFile(DEFAULT_PROPOSAL_HISTORY, "utf8"));
  const repositoryIds = new Set(config.repositories.map((repository) => repository.id));
  const profiles = yamlFiles(join(ROOT, "profiles"));
  const tasks = yamlFiles(join(ROOT, "tasks"));
  const suites = yamlFiles(join(ROOT, "suites"));

  for (const path of profiles) loadProfile(path);
  const taskIds = new Set<string>();
  for (const path of tasks) {
    const task = loadTask(path);
    if (!repositoryIds.has(task.repository)) throw new Error(`${path}: unknown repository ${task.repository}`);
    if (taskIds.has(task.id)) throw new Error(`${path}: duplicate task id ${task.id}`);
    taskIds.add(task.id);
  }
  for (const path of suites) {
    const suite = loadSuite(path);
    for (const taskId of [...suite.diagnosis, ...suite.validation, ...suite.test]) {
      if (!taskIds.has(taskId)) throw new Error(`${path}: unknown task ${taskId}`);
    }
  }

  console.log(
    `Validated ${config.repositories.length} repositories, ${profiles.length} profiles, ${tasks.length} tasks, ${suites.length} suites.`,
  );
}

function evaluationOptions(args: ParsedArgs) {
  return {
    thinking: flag(args, "thinking"),
    piCommand: flag(args, "pi-command"),
    runsDirectory: resolve(flag(args, "runs-directory") ?? join(ROOT, ".runs")),
    keepWorktree: args.flags.get("keep-worktree") === true,
    allowUnsandboxedAgent: args.flags.get("allow-unsandboxed-agent") === true,
  };
}

async function run(args: ParsedArgs) {
  const taskPath = args.positional[0];
  if (!taskPath) throw new Error("run requires a task manifest path");
  const profilePath = requiredFlag(args, "profile");
  const model = requiredFlag(args, "model");
  const config = loadRepositoryConfig(repositoriesPath(args));
  const task = loadTask(resolve(taskPath));
  const profile = loadProfile(resolve(profilePath));
  const repository = config.repositories.find((entry) => entry.id === task.repository);
  if (!repository) throw new Error(`Unknown repository ${task.repository}`);
  if (!existsSync(repository.path)) throw new Error(`Repository path does not exist: ${repository.path}`);

  const { result, resultPath } = await evaluate({
    task,
    repository,
    profile,
    model,
    ...evaluationOptions(args),
  });

  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.taskId} profile=${result.profileId}`);
  console.log(resultPath);
  if (!result.passed) process.exitCode = 1;
}

function positiveIntegerFlag(args: ParsedArgs, name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function parseSplit(args: ParsedArgs): SuiteSplit {
  const split = requiredFlag(args, "split");
  if (split !== "diagnosis" && split !== "validation" && split !== "test") {
    throw new Error("--split must be diagnosis, validation, or test");
  }
  return split;
}

async function runSuite(args: ParsedArgs) {
  const suitePath = args.positional[0];
  if (!suitePath) throw new Error("suite requires a suite manifest path");
  const split = parseSplit(args);
  const profile = loadProfile(resolve(requiredFlag(args, "profile")));
  const model = requiredFlag(args, "model");
  const suite = loadSuite(resolve(suitePath));
  const taskIds = taskIdsForSplit(suite, split);
  if (!taskIds.length) throw new Error(`Suite ${suite.id} has no tasks in its ${split} split`);

  const tasksById = new Map(yamlFiles(join(ROOT, "tasks")).map((path) => {
    const task = loadTask(path);
    return [task.id, task] as const;
  }));
  const repositories = loadRepositoryConfig(repositoriesPath(args)).repositories;
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const options = evaluationOptions(args);
  const startedAt = new Date().toISOString();
  const summaryId = `${startedAt.replace(/[:.]/g, "-")}_${suite.id}_${split}_${profile.id}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  const summaryDirectory = join(options.runsDirectory, "suites", suite.id, summaryId);
  const summaryPath = join(summaryDirectory, "summary.json");
  await mkdir(summaryDirectory, { recursive: true });

  const trials = positiveIntegerFlag(args, "trials", 1);
  const taskResults: SuiteTaskResult[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    for (const taskId of taskIds) {
      const task = tasksById.get(taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      const repository = repositoriesById.get(task.repository);
      if (!repository) throw new Error(`Unknown repository ${task.repository}`);
      if (!existsSync(repository.path)) throw new Error(`Repository path does not exist: ${repository.path}`);

      try {
        const evaluation = await evaluate({ task, repository, profile, model, ...options });
        const taskResult = suiteTaskResult(evaluation.result, evaluation.resultPath, trial);
        taskResults.push(taskResult);
        console.log(`${taskResult.passed ? "PASS" : "FAIL"} ${taskId} profile=${profile.id} trial=${trial}`);
      } catch (error) {
        taskResults.push({
          taskId,
          trial,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        });
        console.log(`ERROR ${taskId} profile=${profile.id} trial=${trial}`);
      }

      const partial = summarizeSuite({
        suite,
        split,
        profileId: profile.id,
        model,
        thinking: options.thinking,
        startedAt,
        finishedAt: new Date().toISOString(),
        trials,
        tasks: taskResults,
      });
      await writeFile(summaryPath, `${JSON.stringify(partial, null, 2)}\n`, { mode: 0o600 });
    }
  }

  const summary = summarizeSuite({
    suite,
    split,
    profileId: profile.id,
    model,
    thinking: options.thinking,
    startedAt,
    finishedAt: new Date().toISOString(),
    trials,
    tasks: taskResults,
  });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`${summary.passedTasks}/${summary.totalTasks} passed; cost=${summary.totalCost.toFixed(4)}`);
  console.log(summaryPath);
  if (!summary.passed) process.exitCode = 1;
}

async function runExperiment(args: ParsedArgs) {
  const suitePath = args.positional[0];
  if (!suitePath) throw new Error("experiment requires a suite manifest path");
  const split = parseSplit(args);
  const baselinePath = resolve(requiredFlag(args, "baseline"));
  const candidatePath = resolve(requiredFlag(args, "candidate"));
  const baseline = loadProfile(baselinePath);
  const candidate = loadProfile(candidatePath);
  if (baseline.id === candidate.id) throw new Error("Baseline and candidate profiles must differ");
  const model = requiredFlag(args, "model");
  const suite = loadSuite(resolve(suitePath));
  const taskIds = taskIdsForSplit(suite, split);
  if (!taskIds.length) throw new Error(`Suite ${suite.id} has no tasks in its ${split} split`);
  const trials = positiveIntegerFlag(args, "trials", 3);
  const minimumTrials = positiveIntegerFlag(args, "minimum-trials", 3);
  const plan = buildExperimentPlan(taskIds, trials);

  const tasksById = new Map(yamlFiles(join(ROOT, "tasks")).map((path) => {
    const task = loadTask(path);
    return [task.id, task] as const;
  }));
  const repositories = loadRepositoryConfig(repositoriesPath(args)).repositories;
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const repository = repositoriesById.get(task.repository);
    if (!repository) throw new Error(`Unknown repository ${task.repository}`);
    if (!existsSync(repository.path)) throw new Error(`Repository path does not exist: ${repository.path}`);
  }

  const options = evaluationOptions(args);
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}_${suite.id}_${split}_${baseline.id}_vs_${candidate.id}`.replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
  const directory = join(options.runsDirectory, "experiments", suite.id, runId);
  const paths = experimentSummaryPaths(directory);
  await mkdir(directory, { recursive: true });
  const baselineTasks: SuiteTaskResult[] = [];
  const candidateTasks: SuiteTaskResult[] = [];
  const executions: ExperimentExecution[] = [];
  const profileByRole = { baseline, candidate };
  const profileTasks = { baseline: baselineTasks, candidate: candidateTasks };
  const profileHashes = {
    baseline: createHash("sha256").update(await readFile(baselinePath)).digest("hex"),
    candidate: createHash("sha256").update(await readFile(candidatePath)).digest("hex"),
  };

  const profileSummary = (role: "baseline" | "candidate") => summarizeSuite({
    suite,
    split,
    profileId: profileByRole[role].id,
    model,
    thinking: options.thinking,
    startedAt,
    finishedAt: new Date().toISOString(),
    trials,
    tasks: profileTasks[role],
  });
  const writeProgress = async (status: ExperimentSummary["status"], comparison?: ReturnType<typeof compareSuiteRuns>) => {
    const baselineSummary = profileSummary("baseline");
    const candidateSummary = profileSummary("candidate");
    await writeFile(paths.baseline, `${JSON.stringify(baselineSummary, null, 2)}\n`, { mode: 0o600 });
    await writeFile(paths.candidate, `${JSON.stringify(candidateSummary, null, 2)}\n`, { mode: 0o600 });
    const experiment: ExperimentSummary = {
      version: 1,
      runId,
      suiteId: suite.id,
      split,
      model,
      thinking: options.thinking,
      trials,
      startedAt,
      finishedAt: status === "completed" ? new Date().toISOString() : undefined,
      status,
      baselineProfileId: baseline.id,
      baselineProfileSha256: profileHashes.baseline,
      candidateProfileId: candidate.id,
      candidateProfileSha256: profileHashes.candidate,
      baselineSummaryPath: paths.baseline,
      candidateSummaryPath: paths.candidate,
      comparisonPath: paths.comparison,
      executions,
      comparison,
    };
    await writeFile(paths.experiment, `${JSON.stringify(experiment, null, 2)}\n`, { mode: 0o600 });
  };

  for (const step of plan) {
    const task = tasksById.get(step.taskId)!;
    const repository = repositoriesById.get(task.repository)!;
    const profile = profileByRole[step.profile];
    let taskResult: SuiteTaskResult;
    try {
      const evaluation = await evaluate({ task, repository, profile, model, ...options });
      taskResult = suiteTaskResult(evaluation.result, evaluation.resultPath, step.trial);
    } catch (error) {
      taskResult = {
        taskId: task.id,
        trial: step.trial,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    profileTasks[step.profile].push(taskResult);
    executions.push({
      ...step,
      profileId: profile.id,
      passed: taskResult.passed,
      resultPath: taskResult.resultPath,
      error: taskResult.error,
    });
    console.log(
      `${taskResult.passed ? "PASS" : "FAIL"} ${task.id} profile=${profile.id} trial=${step.trial} sequence=${step.sequence}`,
    );
    await writeProgress("running");
  }

  const comparison = compareSuiteRuns(profileSummary("baseline"), profileSummary("candidate"), minimumTrials);
  await writeFile(paths.comparison, `${JSON.stringify(comparison, null, 2)}\n`, { mode: 0o600 });
  await writeProgress("completed", comparison);
  console.log(`${comparison.recommendation}: cost delta=${((comparison.delta.costFraction ?? 0) * 100).toFixed(1)}%`);
  console.log(paths.experiment);
  if (comparison.recommendation === "reject") process.exitCode = 1;
}

async function compare(args: ParsedArgs) {
  const [baselinePath, candidatePath] = args.positional;
  if (!baselinePath || !candidatePath) throw new Error("compare requires baseline and candidate summary paths");
  const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf8")) as SuiteRunSummary;
  const candidate = JSON.parse(await readFile(resolve(candidatePath), "utf8")) as SuiteRunSummary;
  const comparison = compareSuiteRuns(baseline, candidate, positiveIntegerFlag(args, "minimum-trials", 3));
  const text = `${JSON.stringify(comparison, null, 2)}\n`;
  const output = flag(args, "output");
  if (output) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, text, { mode: 0o600 });
  }
  process.stdout.write(text);
  if (comparison.recommendation === "reject") process.exitCode = 1;
}

async function mine(args: ParsedArgs) {
  const summaryPath = args.positional[0];
  if (!summaryPath) throw new Error("mine requires a diagnosis summary path");
  const summary = JSON.parse(await readFile(resolve(summaryPath), "utf8")) as SuiteRunSummary;
  const results = new Map<string, EvaluationResult>();
  const toolErrors = new Map<string, ToolErrorEvidence[]>();
  for (const task of summary.tasks) {
    if (!task.resultPath || results.has(task.resultPath)) continue;
    results.set(task.resultPath, JSON.parse(await readFile(task.resultPath, "utf8")) as EvaluationResult);
    const tracePath = join(dirname(task.resultPath), "agent.jsonl");
    if (existsSync(tracePath)) toolErrors.set(task.resultPath, extractToolErrorEvidence(await readFile(tracePath, "utf8")));
  }
  const evidence = buildWeaknessEvidence(summary, results, toolErrors);
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  const output = flag(args, "output");
  if (output) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, text, { flag: "wx", mode: 0o600 });
  } else {
    process.stdout.write(text);
  }
}

async function propose(args: ParsedArgs) {
  const evidencePath = args.positional[0];
  if (!evidencePath) throw new Error("propose requires a weakness evidence path");
  const candidateId = requiredFlag(args, "id");
  const model = requiredFlag(args, "model");
  const outputPath = resolve(requiredFlag(args, "output"));
  if (existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
  const evidenceText = await readFile(resolve(evidencePath), "utf8");
  const evidence = JSON.parse(evidenceText) as WeaknessEvidence;
  if (evidence.version !== 1 || evidence.split !== "diagnosis" || !Array.isArray(evidence.tasks)) {
    throw new Error("Invalid weakness evidence document");
  }

  const thinking = flag(args, "thinking") ?? evidence.thinking;
  const historyPath = resolve(flag(args, "history") ?? DEFAULT_PROPOSAL_HISTORY);
  const historyText = existsSync(historyPath) ? await readFile(historyPath, "utf8") : "version: 1\nrejections: []\n";
  const history = parseProposalHistory(historyText).filter((rejection) => !rejection.model || rejection.model === evidence.model);
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}_${candidateId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  const runDirectory = resolve(
    flag(args, "runs-directory") ?? join(ROOT, ".runs"),
    "proposals",
    candidateId,
    runId,
  );
  await mkdir(runDirectory, { recursive: true });
  const tracePath = join(runDirectory, "proposal.jsonl");
  const stderrPath = join(runDirectory, "proposal.stderr.log");
  const prompt = buildProposalPrompt(evidence, candidateId, history);
  const piArgs = buildProposalPiArgs({ model, thinking, prompt });

  const processResult = await runProcess({
    command: flag(args, "pi-command") ?? "pi",
    args: piArgs,
    cwd: ROOT,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    timeoutMs: positiveIntegerFlag(args, "proposal-timeout", 300) * 1_000,
    stdoutPath: tracePath,
    stderrPath,
  });
  const trace = summarizeTraceText(processResult.stdoutTail);
  let error: string | undefined;
  let profile: HarnessProfile | undefined;
  try {
    if (processResult.code !== 0 || processResult.timedOut) {
      throw new Error(processResult.stderrTail || `Pi proposal process exited with code ${processResult.code}`);
    }
    if (!trace.finalText) throw new Error("Pi proposal process returned no final text");
    profile = parseProposedProfile(trace.finalText, candidateId, evidence);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, formatProfile(profile), { flag: "wx", mode: 0o600 });
    loadProfile(outputPath);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const proposalResult = {
    version: 1,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    evidencePath: resolve(evidencePath),
    evidenceSha256: createHash("sha256").update(evidenceText).digest("hex"),
    historyPath,
    historySha256: createHash("sha256").update(historyText).digest("hex"),
    targetModel: evidence.model,
    proposalModel: model,
    thinking,
    outputPath,
    generated: Boolean(profile),
    error,
    tracePath,
    process: { ...processResult, stdoutTail: "" },
    trace,
  };
  const resultPath = join(runDirectory, "result.json");
  await writeFile(resultPath, `${JSON.stringify(proposalResult, null, 2)}\n`, { mode: 0o600 });
  if (error) throw new Error(`${error}\n${resultPath}`);
  console.log(outputPath);
  console.log(resultPath);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  switch (command) {
    case "repositories":
      await showRepositories(args);
      break;
    case "validate":
      await validate(args);
      break;
    case "run":
      await run(args);
      break;
    case "suite":
      await runSuite(args);
      break;
    case "experiment":
      await runExperiment(args);
      break;
    case "compare":
      await compare(args);
      break;
    case "mine":
      await mine(args);
      break;
    case "propose":
      await propose(args);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(usage());
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
