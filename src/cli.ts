#!/usr/bin/env -S node --experimental-strip-types

import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";
import { loadProfile, loadRepositoryConfig, loadSuite, loadTask } from "./config.ts";
import { compareSuiteRuns } from "./comparison.ts";
import { buildExperimentPlan, experimentSummaryPaths, type ExperimentExecution, type ExperimentSummary } from "./experiment.ts";
import { evaluatorInfrastructureFailure } from "./infrastructure.ts";
import { buildWeaknessEvidence, extractToolErrorEvidence, type ToolErrorEvidence, type WeaknessEvidence } from "./mining.ts";
import {
  buildBatchProposalPrompt,
  buildProposalPrompt,
  formatProfile,
  parseProposalHistory,
  parseProposedProfile,
  parseProposedProfiles,
} from "./proposal.ts";
import { runProposalModel } from "./proposal-runner.ts";
import { applyReverificationOverrides, loadVerifiedReverification } from "./reverification.ts";
import { evaluate, reverify } from "./runner.ts";
import {
  buildScreeningPlan,
  rankScreeningComparisons,
  screeningSummaryPaths,
  type ScreeningExecution,
  type ScreeningSummary,
} from "./screening.ts";
import { compareTerminalBenchJobs, loadTerminalBenchJob } from "./terminal-bench.ts";
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

  reverify RESULT.json --task TASK.yaml [options]
      Reapply a captured agent patch and append a result from the current verifier.

  suite SUITE.yaml --split diagnosis|validation|test --profile PROFILE.yaml --model PROVIDER/MODEL [options]
      Run one suite split sequentially and write an aggregate summary.

  experiment SUITE.yaml --split SPLIT --baseline PROFILE.yaml --candidate PROFILE.yaml --model PROVIDER/MODEL [options]
      Run an interleaved repeated baseline/candidate experiment and compare it.

  screen SUITE.yaml --baseline PROFILE.yaml --candidates PROFILE1.yaml,PROFILE2.yaml --model PROVIDER/MODEL [options]
      Run one diagnosis trial with a shared baseline and rank up to five candidates.

  compare BASELINE-SUMMARY.json CANDIDATE-SUMMARY.json [--minimum-trials N] [--output PATH]
      Compare paired suite runs and produce a bounded promotion recommendation.

  terminal-bench-compare BASELINE-JOB CANDIDATE-JOB [--max-cost-regression FRACTION] [--output PATH]
      Compare complete Harbor jobs from the pinned Terminal-Bench regression subset.

  mine DIAGNOSIS-SUMMARY.json [--reverifications RESULT.json,...] [--output PATH]
      Extract bounded, agent-visible weakness evidence from diagnosis results.

  propose EVIDENCE.json --id ID --model PROVIDER/MODEL --output PROFILE.yaml [--history PATH] [options]
      Ask a tool-free Pi process for one bounded declarative candidate profile.

  propose-batch EVIDENCE.json --prefix ID --count N --model PROVIDER/MODEL --output-directory PATH [options]
      Ask one tool-free Pi process for up to five distinct bounded candidates.

Run options:
  --thinking LEVEL
  --pi-command PATH
  --runs-directory PATH
  --trials N                 Suite default 1; experiment default 3.
  --retain N                 Screening finalists; default 1.
  --proposal-timeout SECONDS Proposal timeout; default 300.
  --keep-worktree
  --allow-unsandboxed-agent      Required acknowledgement for local agent tasks.
  --allow-unsandboxed-verifier   Required acknowledgement for local reverification.
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

async function runReverification(args: ParsedArgs) {
  const originalResultPath = args.positional[0];
  if (!originalResultPath) throw new Error("reverify requires an evaluation result path");
  const taskManifestPath = resolve(requiredFlag(args, "task"));
  const task = loadTask(taskManifestPath);
  const config = loadRepositoryConfig(repositoriesPath(args));
  const repository = config.repositories.find((entry) => entry.id === task.repository);
  if (!repository) throw new Error(`Unknown repository ${task.repository}`);
  if (!existsSync(repository.path)) throw new Error(`Repository path does not exist: ${repository.path}`);

  const { result, resultPath } = await reverify({
    originalResultPath: resolve(originalResultPath),
    task,
    taskManifestPath,
    repository,
    keepWorktree: args.flags.get("keep-worktree") === true,
    allowUnsandboxedVerifier: args.flags.get("allow-unsandboxed-verifier") === true,
  });
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.taskId} reverification=${result.reverificationId}`);
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
      let invalidReason: string | undefined;
      const task = tasksById.get(taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      const repository = repositoriesById.get(task.repository);
      if (!repository) throw new Error(`Unknown repository ${task.repository}`);
      if (!existsSync(repository.path)) throw new Error(`Repository path does not exist: ${repository.path}`);

      try {
        const evaluation = await evaluate({ task, repository, profile, model, ...options });
        const taskResult = suiteTaskResult(evaluation.result, evaluation.resultPath, trial);
        invalidReason = evaluatorInfrastructureFailure(evaluation.result);
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

      const partial = {
        ...summarizeSuite({
          suite,
          split,
          profileId: profile.id,
          model,
          thinking: options.thinking,
          startedAt,
          finishedAt: new Date().toISOString(),
          trials,
          tasks: taskResults,
        }),
        invalidReason,
      };
      await writeFile(summaryPath, `${JSON.stringify(partial, null, 2)}\n`, { mode: 0o600 });
      if (invalidReason) {
        throw new Error(`Suite invalid because evaluator infrastructure failed: ${invalidReason}\n${summaryPath}`);
      }
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
  const writeProgress = async (
    status: ExperimentSummary["status"],
    comparison?: ReturnType<typeof compareSuiteRuns>,
    invalidReason?: string,
  ) => {
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
      finishedAt: status === "running" ? undefined : new Date().toISOString(),
      status,
      invalidReason,
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
    let invalidReason: string | undefined;
    try {
      const evaluation = await evaluate({ task, repository, profile, model, ...options });
      taskResult = suiteTaskResult(evaluation.result, evaluation.resultPath, step.trial);
      invalidReason = evaluatorInfrastructureFailure(evaluation.result);
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
    if (invalidReason) {
      await writeProgress("invalid", undefined, invalidReason);
      throw new Error(`Experiment invalid because evaluator infrastructure failed: ${invalidReason}\n${paths.experiment}`);
    }
    await writeProgress("running");
  }

  const comparison = compareSuiteRuns(profileSummary("baseline"), profileSummary("candidate"), minimumTrials);
  await writeFile(paths.comparison, `${JSON.stringify(comparison, null, 2)}\n`, { mode: 0o600 });
  await writeProgress("completed", comparison);
  console.log(`${comparison.recommendation}: cost delta=${((comparison.delta.costFraction ?? 0) * 100).toFixed(1)}%`);
  console.log(paths.experiment);
  if (comparison.recommendation === "reject") process.exitCode = 1;
}

async function runScreening(args: ParsedArgs) {
  const suitePath = args.positional[0];
  if (!suitePath) throw new Error("screen requires a suite manifest path");
  const baselinePath = resolve(requiredFlag(args, "baseline"));
  const candidatePaths = requiredFlag(args, "candidates").split(",").map((path) => path.trim()).filter(Boolean).map((path) => resolve(path));
  if (!candidatePaths.length || candidatePaths.length > 5) throw new Error("--candidates requires one to five profile paths");
  const retain = positiveIntegerFlag(args, "retain", 1);
  if (retain > candidatePaths.length) throw new Error("--retain cannot exceed the candidate count");
  const baseline = loadProfile(baselinePath);
  const candidates = candidatePaths.map((path) => loadProfile(path));
  const profiles: HarnessProfile[] = [baseline, ...candidates];
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("Screening profile ids must be unique");
  }
  const model = requiredFlag(args, "model");
  const suite = loadSuite(resolve(suitePath));
  const split = "diagnosis" as const;
  const taskIds = taskIdsForSplit(suite, split);
  if (!taskIds.length) throw new Error(`Suite ${suite.id} has no tasks in its diagnosis split`);
  const plan = buildScreeningPlan(taskIds, profiles.map((profile) => profile.id));

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

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const profilePathById = new Map([
    [baseline.id, baselinePath],
    ...candidates.map((candidate, index) => [candidate.id, candidatePaths[index]] as const),
  ]);
  const profileHashes = new Map<string, string>();
  for (const profile of profiles) {
    profileHashes.set(profile.id, createHash("sha256").update(await readFile(profilePathById.get(profile.id)!)).digest("hex"));
  }
  const options = evaluationOptions(args);
  const startedAt = new Date().toISOString();
  const fingerprint = createHash("sha256").update([...profileHashes.values()].join(":"), "utf8").digest("hex").slice(0, 10);
  const runId = `${startedAt.replace(/[:.]/g, "-")}_${suite.id}_diagnosis_screen_${fingerprint}`.replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
  const directory = join(options.runsDirectory, "screenings", suite.id, runId);
  const paths = screeningSummaryPaths(directory, candidates.map((candidate) => candidate.id));
  await mkdir(directory, { recursive: true });
  const profileTasks = new Map(profiles.map((profile) => [profile.id, [] as SuiteTaskResult[]]));
  const executions: ScreeningExecution[] = [];

  const profileSummary = (profile: HarnessProfile) => summarizeSuite({
    suite,
    split,
    profileId: profile.id,
    model,
    thinking: options.thinking,
    startedAt,
    finishedAt: new Date().toISOString(),
    trials: 1,
    tasks: profileTasks.get(profile.id)!,
  });
  const candidateMetadata = candidates.map((candidate) => ({
    id: candidate.id,
    sha256: profileHashes.get(candidate.id)!,
    summaryPath: paths.candidates.get(candidate.id)!.summary,
    comparisonPath: paths.candidates.get(candidate.id)!.comparison,
  }));
  const writeProgress = async (
    status: ScreeningSummary["status"],
    ranking?: ReturnType<typeof rankScreeningComparisons>,
    invalidReason?: string,
  ) => {
    await writeFile(paths.baseline, `${JSON.stringify(profileSummary(baseline), null, 2)}\n`, { mode: 0o600 });
    for (const candidate of candidates) {
      await writeFile(
        paths.candidates.get(candidate.id)!.summary,
        `${JSON.stringify(profileSummary(candidate), null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    const summary: ScreeningSummary = {
      version: 1,
      screeningOnly: true,
      runId,
      suiteId: suite.id,
      split,
      model,
      thinking: options.thinking,
      startedAt,
      finishedAt: status === "running" ? undefined : new Date().toISOString(),
      status,
      invalidReason,
      baselineProfileId: baseline.id,
      baselineProfileSha256: profileHashes.get(baseline.id)!,
      baselineSummaryPath: paths.baseline,
      candidateProfiles: candidateMetadata,
      executions,
      ranking,
    };
    await writeFile(paths.screening, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  };

  for (const step of plan) {
    const task = tasksById.get(step.taskId)!;
    const repository = repositoriesById.get(task.repository)!;
    const profile = profileById.get(step.profileId)!;
    let taskResult: SuiteTaskResult;
    let invalidReason: string | undefined;
    try {
      const evaluation = await evaluate({ task, repository, profile, model, ...options });
      taskResult = suiteTaskResult(evaluation.result, evaluation.resultPath, 1);
      invalidReason = evaluatorInfrastructureFailure(evaluation.result);
    } catch (error) {
      taskResult = {
        taskId: task.id,
        trial: 1,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    profileTasks.get(profile.id)!.push(taskResult);
    executions.push({
      ...step,
      passed: taskResult.passed,
      resultPath: taskResult.resultPath,
      error: taskResult.error,
    });
    console.log(`${taskResult.passed ? "PASS" : "FAIL"} ${task.id} profile=${profile.id} sequence=${step.sequence}`);
    if (invalidReason) {
      await writeProgress("invalid", undefined, invalidReason);
      throw new Error(`Screening invalid because evaluator infrastructure failed: ${invalidReason}\n${paths.screening}`);
    }
    await writeProgress("running");
  }

  const comparisons = candidates.map((candidate) => {
    const candidatePaths = paths.candidates.get(candidate.id)!;
    const comparison = compareSuiteRuns(profileSummary(baseline), profileSummary(candidate), 3);
    return { comparisonPath: candidatePaths.comparison, comparison };
  });
  for (const entry of comparisons) {
    await writeFile(entry.comparisonPath, `${JSON.stringify(entry.comparison, null, 2)}\n`, { mode: 0o600 });
  }
  const ranking = rankScreeningComparisons(comparisons, retain);
  await writeProgress("completed", ranking);
  for (const entry of ranking) {
    console.log(
      `#${entry.rank} ${entry.candidateProfileId}: ${entry.disposition}; cost delta=${((entry.comparison.delta.costFraction ?? 0) * 100).toFixed(1)}%`,
    );
  }
  console.log(paths.screening);
  if (!ranking.some((entry) => entry.disposition === "retain-for-full-experiment")) process.exitCode = 1;
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
  const reverificationPaths = (flag(args, "reverifications") ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  const reverifications = await Promise.all(reverificationPaths.map((path) => loadVerifiedReverification(resolve(path))));
  const applied = applyReverificationOverrides(summary, results, reverifications);
  const evidence = buildWeaknessEvidence(applied.summary, applied.resultsByPath, toolErrors, applied.evidence);
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

async function loadProposalInputs(args: ParsedArgs) {
  const evidencePath = args.positional[0];
  if (!evidencePath) throw new Error("proposal command requires a weakness evidence path");
  const resolvedEvidencePath = resolve(evidencePath);
  const evidenceText = await readFile(resolvedEvidencePath, "utf8");
  const evidence = JSON.parse(evidenceText) as WeaknessEvidence;
  if (evidence.version !== 1 || evidence.split !== "diagnosis" || !Array.isArray(evidence.tasks)) {
    throw new Error("Invalid weakness evidence document");
  }
  const historyPath = resolve(flag(args, "history") ?? DEFAULT_PROPOSAL_HISTORY);
  const historyText = existsSync(historyPath) ? await readFile(historyPath, "utf8") : "version: 1\nrejections: []\n";
  const history = parseProposalHistory(historyText).filter(
    (rejection) => !rejection.model || rejection.model === evidence.model,
  );
  return {
    evidencePath: resolvedEvidencePath,
    evidenceText,
    evidence,
    historyPath,
    historyText,
    history,
    model: requiredFlag(args, "model"),
    thinking: flag(args, "thinking") ?? evidence.thinking,
  };
}

function assertProposalProcess(run: Awaited<ReturnType<typeof runProposalModel>>): void {
  if (run.process.code !== 0 || run.process.timedOut) {
    throw new Error(run.process.stderrTail || `Pi proposal process exited with code ${run.process.code}`);
  }
  if (!run.trace.finalText) throw new Error("Pi proposal process returned no final text");
}

async function propose(args: ParsedArgs) {
  const input = await loadProposalInputs(args);
  const candidateId = requiredFlag(args, "id");
  const outputPath = resolve(requiredFlag(args, "output"));
  if (existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
  const run = await runProposalModel({
    root: ROOT,
    runsDirectory: resolve(flag(args, "runs-directory") ?? join(ROOT, ".runs")),
    artifactId: candidateId,
    model: input.model,
    thinking: input.thinking,
    prompt: buildProposalPrompt(input.evidence, candidateId, input.history),
    piCommand: flag(args, "pi-command"),
    timeoutSeconds: positiveIntegerFlag(args, "proposal-timeout", 300),
  });

  let error: string | undefined;
  let generated = false;
  try {
    assertProposalProcess(run);
    const profile = parseProposedProfile(run.trace.finalText!, candidateId, input.evidence);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, formatProfile(profile), { flag: "wx", mode: 0o600 });
    loadProfile(outputPath);
    generated = true;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const resultPath = join(run.runDirectory, "result.json");
  await writeFile(resultPath, `${JSON.stringify({
    version: 1,
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    evidencePath: input.evidencePath,
    evidenceSha256: createHash("sha256").update(input.evidenceText).digest("hex"),
    historyPath: input.historyPath,
    historySha256: createHash("sha256").update(input.historyText).digest("hex"),
    targetModel: input.evidence.model,
    proposalModel: input.model,
    thinking: input.thinking,
    outputPath,
    generated,
    error,
    tracePath: run.tracePath,
    process: { ...run.process, stdoutTail: "" },
    trace: run.trace,
  }, null, 2)}\n`, { mode: 0o600 });
  if (error) throw new Error(`${error}\n${resultPath}`);
  console.log(outputPath);
  console.log(resultPath);
}

async function proposeBatch(args: ParsedArgs) {
  const input = await loadProposalInputs(args);
  const prefix = requiredFlag(args, "prefix");
  const count = positiveIntegerFlag(args, "count", 3);
  if (count > 5) throw new Error("--count cannot exceed 5");
  const candidateIds = Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
  const outputDirectory = resolve(requiredFlag(args, "output-directory"));
  const outputPaths = candidateIds.map((id) => join(outputDirectory, `${id}.yaml`));
  for (const outputPath of outputPaths) {
    if (existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
  }
  const artifactId = `${prefix}-batch`;
  const run = await runProposalModel({
    root: ROOT,
    runsDirectory: resolve(flag(args, "runs-directory") ?? join(ROOT, ".runs")),
    artifactId,
    model: input.model,
    thinking: input.thinking,
    prompt: buildBatchProposalPrompt(input.evidence, candidateIds, input.history),
    piCommand: flag(args, "pi-command"),
    timeoutSeconds: positiveIntegerFlag(args, "proposal-timeout", 300),
  });

  let error: string | undefined;
  const generatedPaths: string[] = [];
  try {
    assertProposalProcess(run);
    const profiles = parseProposedProfiles(run.trace.finalText!, candidateIds, input.evidence);
    await mkdir(outputDirectory, { recursive: true });
    for (const profile of profiles) {
      const outputPath = join(outputDirectory, `${profile.id}.yaml`);
      await writeFile(outputPath, formatProfile(profile), { flag: "wx", mode: 0o600 });
      loadProfile(outputPath);
      generatedPaths.push(outputPath);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const resultPath = join(run.runDirectory, "result.json");
  await writeFile(resultPath, `${JSON.stringify({
    version: 1,
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    evidencePath: input.evidencePath,
    evidenceSha256: createHash("sha256").update(input.evidenceText).digest("hex"),
    historyPath: input.historyPath,
    historySha256: createHash("sha256").update(input.historyText).digest("hex"),
    targetModel: input.evidence.model,
    proposalModel: input.model,
    thinking: input.thinking,
    requestedCandidates: count,
    generatedPaths,
    error,
    tracePath: run.tracePath,
    process: { ...run.process, stdoutTail: "" },
    trace: run.trace,
  }, null, 2)}\n`, { mode: 0o600 });
  if (error) throw new Error(`${error}\n${resultPath}`);
  for (const outputPath of generatedPaths) console.log(outputPath);
  console.log(resultPath);
}

async function compareTerminalBench(args: ParsedArgs) {
  const baselinePath = args.positional[0];
  const candidatePath = args.positional[1];
  if (!baselinePath || !candidatePath) {
    throw new Error("terminal-bench-compare requires baseline and candidate Harbor job paths");
  }
  const rawLimit = flag(args, "max-cost-regression");
  const limit = rawLimit === undefined ? 0.1 : Number(rawLimit);
  if (!Number.isFinite(limit) || limit < 0) throw new Error("--max-cost-regression must be non-negative");
  const report = compareTerminalBenchJobs(
    await loadTerminalBenchJob(baselinePath),
    await loadTerminalBenchJob(candidatePath),
    limit,
  );
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const output = flag(args, "output");
  if (output) {
    const outputPath = resolve(output);
    await writeFile(outputPath, text, { flag: "wx", mode: 0o600 });
    console.log(outputPath);
  } else {
    process.stdout.write(text);
  }
  if (!report.passed) process.exitCode = 1;
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
    case "reverify":
      await runReverification(args);
      break;
    case "suite":
      await runSuite(args);
      break;
    case "experiment":
      await runExperiment(args);
      break;
    case "screen":
      await runScreening(args);
      break;
    case "compare":
      await compare(args);
      break;
    case "terminal-bench-compare":
      await compareTerminalBench(args);
      break;
    case "mine":
      await mine(args);
      break;
    case "propose":
      await propose(args);
      break;
    case "propose-batch":
      await proposeBatch(args);
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
