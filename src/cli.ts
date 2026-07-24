#!/usr/bin/env -S node --experimental-strip-types

import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";
import { loadProfile, loadRepositoryConfig, loadSuite, loadTask } from "./config.ts";
import { evaluate } from "./runner.ts";
import { summarizeSuite, suiteTaskResult, taskIdsForSplit, type SuiteSplit, type SuiteTaskResult } from "./suite.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORIES = join(ROOT, "config", "repositories.yaml");

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

Run options:
  --thinking LEVEL
  --pi-command PATH
  --runs-directory PATH
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

  const taskResults: SuiteTaskResult[] = [];
  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const repository = repositoriesById.get(task.repository);
    if (!repository) throw new Error(`Unknown repository ${task.repository}`);
    if (!existsSync(repository.path)) throw new Error(`Repository path does not exist: ${repository.path}`);

    try {
      const evaluation = await evaluate({ task, repository, profile, model, ...options });
      const taskResult = suiteTaskResult(evaluation.result, evaluation.resultPath);
      taskResults.push(taskResult);
      console.log(`${taskResult.passed ? "PASS" : "FAIL"} ${taskId} profile=${profile.id}`);
    } catch (error) {
      taskResults.push({
        taskId,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.log(`ERROR ${taskId} profile=${profile.id}`);
    }

    const partial = summarizeSuite({
      suite,
      split,
      profileId: profile.id,
      model,
      thinking: options.thinking,
      startedAt,
      finishedAt: new Date().toISOString(),
      tasks: taskResults,
    });
    await writeFile(summaryPath, `${JSON.stringify(partial, null, 2)}\n`, { mode: 0o600 });
  }

  const summary = summarizeSuite({
    suite,
    split,
    profileId: profile.id,
    model,
    thinking: options.thinking,
    startedAt,
    finishedAt: new Date().toISOString(),
    tasks: taskResults,
  });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`${summary.passedTasks}/${summary.totalTasks} passed; cost=${summary.totalCost.toFixed(4)}`);
  console.log(summaryPath);
  if (!summary.passed) process.exitCode = 1;
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
