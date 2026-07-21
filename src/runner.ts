import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CONTAINER_WORKSPACE,
  runContainerShell,
  startContainer,
  stopContainer,
  type ContainerSpec,
} from "./container.ts";
import type {
  CommandSpec,
  EvaluationResult,
  ExecutorRequirement,
  HarnessProfile,
  ProcessResult,
  RepositoryDefinition,
  TaskDefinition,
  VerificationAsset,
} from "./types.ts";
import { runProcess, runShell } from "./process.ts";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 900;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
const CONTAINER_TOOL_NAMES = new Set(["read", "bash", "edit", "write"]);
const CONTAINER_EXTENSION = fileURLToPath(new URL("../extension/container-tools.ts", import.meta.url));

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function mergeExecutor(repository: ExecutorRequirement | undefined, task: ExecutorRequirement | undefined): ExecutorRequirement {
  return {
    type: task?.type ?? repository?.type ?? "local",
    os: task?.os ?? repository?.os,
    arch: task?.arch ?? repository?.arch,
    requires: [...new Set([...(repository?.requires ?? []), ...(task?.requires ?? [])])],
    runtime: task?.runtime ?? repository?.runtime,
    image: task?.image ?? repository?.image,
    setupNetwork: task?.setupNetwork ?? repository?.setupNetwork,
    agentNetwork: task?.agentNetwork ?? repository?.agentNetwork,
  };
}

export function assertExecutorCompatible(requirement: ExecutorRequirement): void {
  if (requirement.type === "container") {
    if (requirement.os && requirement.os !== "linux") {
      throw new Error(`Container executor only supports Linux guests, not ${requirement.os}`);
    }
    if (!requirement.image) throw new Error("Container executor requires an image");
    return;
  }
  if (requirement.os && requirement.os !== process.platform) {
    throw new Error(`Task requires ${requirement.os}; current OS is ${process.platform}`);
  }
  if (requirement.arch && requirement.arch !== process.arch) {
    throw new Error(`Task requires ${requirement.arch}; current architecture is ${process.arch}`);
  }
}

export function assertCommandAllowed(command: string, repository: RepositoryDefinition): void {
  for (const forbidden of repository.safety?.forbiddenCommands ?? []) {
    if (command.toLowerCase().includes(forbidden.toLowerCase())) {
      throw new Error(`Command contains forbidden repository pattern ${JSON.stringify(forbidden)}: ${command}`);
    }
  }
}

export function buildPiArgs(input: {
  task: TaskDefinition;
  profile: HarnessProfile;
  model: string;
  thinking?: string;
  requiredExtensions?: string[];
}): string[] {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--model",
    input.model,
  ];
  if (input.thinking) args.push("--thinking", input.thinking);
  if (input.profile.tools?.length) args.push("--tools", input.profile.tools.join(","));
  for (const extension of input.requiredExtensions ?? []) args.push("--extension", extension);
  if (input.profile.systemPromptAppend) args.push("--append-system-prompt", input.profile.systemPromptAppend);
  args.push(input.task.prompt);
  return args;
}

async function git(repositoryPath: string, args: string[], timeoutMs = 60_000): Promise<ProcessResult> {
  return runProcess({ command: "git", args: ["-C", repositoryPath, ...args], cwd: repositoryPath, timeoutMs });
}

function successful(result: ProcessResult): boolean {
  return result.code === 0 && !result.timedOut;
}

async function runLocalCommand(
  spec: CommandSpec,
  cwd: string,
  stdoutPath: string,
  stderrPath: string,
): Promise<ProcessResult> {
  return runShell(spec.command, {
    cwd,
    timeoutMs: (spec.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1_000,
    stdoutPath,
    stderrPath,
  });
}

function pathIsInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function injectVerificationAssets(
  assets: VerificationAsset[] | undefined,
  worktree: string,
): Promise<string[]> {
  if (!assets?.length) return [];
  const worktreeRoot = await realpath(worktree);
  const injected: string[] = [];
  for (const asset of assets) {
    const target = resolve(worktree, asset.destination);
    if (!pathIsInside(worktree, target)) throw new Error(`Verifier destination escapes worktree: ${asset.destination}`);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const canonicalParent = await realpath(parent);
    if (!pathIsInside(worktreeRoot, canonicalParent)) {
      throw new Error(`Verifier destination parent escapes worktree through a symlink: ${asset.destination}`);
    }
    await copyFile(asset.source, target, constants.COPYFILE_EXCL);
    injected.push(asset.destination);
  }
  return injected;
}

async function runContainerCommand(
  spec: CommandSpec,
  runtime: "podman" | "docker",
  name: string,
  cwd: string,
  stdoutPath: string,
  stderrPath: string,
): Promise<ProcessResult> {
  return runContainerShell({
    runtime,
    name,
    command: spec.command,
    cwd,
    timeoutMs: (spec.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1_000,
    stdoutPath,
    stderrPath,
  });
}

export interface EvaluateOptions {
  task: TaskDefinition;
  repository: RepositoryDefinition;
  profile: HarnessProfile;
  model: string;
  thinking?: string;
  piCommand?: string;
  runsDirectory: string;
  keepWorktree?: boolean;
  allowUnsandboxedAgent: boolean;
}

export async function evaluate(options: EvaluateOptions): Promise<{ result: EvaluationResult; resultPath: string }> {
  const executor = mergeExecutor(options.repository.executor, options.task.executor);
  assertExecutorCompatible(executor);
  const containerized = executor.type === "container";
  if (!containerized && !options.allowUnsandboxedAgent) {
    throw new Error(
      "Local Pi execution is not sandboxed. Pass --allow-unsandboxed-agent only after reviewing the task and repository safety constraints.",
    );
  }
  if (containerized) {
    const unsupportedTools = (options.profile.tools ?? []).filter((tool) => !CONTAINER_TOOL_NAMES.has(tool));
    if (unsupportedTools.length) {
      throw new Error(`Container executor does not yet support tools: ${unsupportedTools.join(", ")}`);
    }
  }

  const verification = options.task.verification ?? options.repository.defaultVerification;
  if (!verification) throw new Error(`Task ${options.task.id} has no verification command`);
  if (options.task.setup) assertCommandAllowed(options.task.setup.command, options.repository);
  assertCommandAllowed(verification.command, options.repository);

  const revisionResult = await git(options.repository.path, ["rev-parse", "--verify", `${options.task.baseRevision}^{commit}`]);
  if (!successful(revisionResult)) {
    throw new Error(`Could not resolve ${options.task.baseRevision} in ${options.repository.path}: ${revisionResult.stderrTail}`);
  }
  const sourceRevision = revisionResult.stdoutTail.trim();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${timestamp}_${safeId(options.task.id)}_${safeId(options.profile.id)}`;
  const runDirectory = resolve(options.runsDirectory, safeId(options.task.id), runId);
  await mkdir(runDirectory, { recursive: true });

  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-self-harness-"));
  const worktree = join(temporaryRoot, "worktree");
  const cacheDirectory = join(temporaryRoot, "cache");
  await mkdir(cacheDirectory, { recursive: true });
  const worktreeResult = await git(options.repository.path, ["worktree", "add", "--detach", worktree, sourceRevision], 120_000);
  if (!successful(worktreeResult)) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw new Error(`Could not create worktree: ${worktreeResult.stderrTail}`);
  }

  const startedAt = new Date().toISOString();
  const result: EvaluationResult = {
    version: 1,
    runId,
    taskId: options.task.id,
    repositoryId: options.repository.id,
    profileId: options.profile.id,
    model: options.model,
    thinking: options.thinking,
    executor: containerized ? "container" : "local",
    containerImage: containerized ? executor.image : undefined,
    startedAt,
    finishedAt: startedAt,
    passed: false,
    worktree: options.keepWorktree ? worktree : undefined,
    sourceRevision,
  };

  const resultPath = join(runDirectory, "result.json");
  const runtime = executor.runtime ?? "podman";
  const containerBase = safeId(`psh-${runId}`).slice(-63);
  let activeContainer: string | undefined;

  const start = async (name: string, network: "none" | "bridge") => {
    const spec: ContainerSpec = {
      runtime,
      image: executor.image!,
      name,
      worktree,
      cacheDirectory,
      network,
    };
    const started = await startContainer(spec, worktree);
    if (!successful(started)) throw new Error(`Could not start ${runtime} container: ${started.stderrTail || started.stdoutTail}`);
    activeContainer = name;
  };
  const stop = async (): Promise<ProcessResult | undefined> => {
    if (!activeContainer) return undefined;
    const stopped = await stopContainer(runtime, activeContainer, worktree);
    if (successful(stopped)) activeContainer = undefined;
    return stopped;
  };

  try {
    if (containerized && options.task.setup) {
      await start(`${containerBase}-setup`.slice(-63), executor.setupNetwork ?? "bridge");
      result.setup = await runContainerCommand(
        options.task.setup,
        runtime,
        activeContainer!,
        worktree,
        join(runDirectory, "setup.stdout.log"),
        join(runDirectory, "setup.stderr.log"),
      );
      const setupContainerStop = await stop();
      if (setupContainerStop && !successful(setupContainerStop)) {
        throw new Error(`Could not stop setup container: ${setupContainerStop.stderrTail || setupContainerStop.stdoutTail}`);
      }
      if (!successful(result.setup)) {
        result.failureStage = "setup";
        return { result, resultPath };
      }
    } else if (options.task.setup) {
      result.setup = await runLocalCommand(
        options.task.setup,
        worktree,
        join(runDirectory, "setup.stdout.log"),
        join(runDirectory, "setup.stderr.log"),
      );
      if (!successful(result.setup)) {
        result.failureStage = "setup";
        return { result, resultPath };
      }
    }

    if (containerized) await start(`${containerBase}-agent`.slice(-63), executor.agentNetwork ?? "none");

    const requiredExtensions = containerized ? [CONTAINER_EXTENSION] : [];
    const env = containerized
      ? {
          ...process.env,
          PI_SELF_HARNESS_CONTAINER: JSON.stringify({
            runtime,
            container: activeContainer,
            hostCwd: worktree,
            guestCwd: CONTAINER_WORKSPACE,
          }),
        }
      : process.env;
    result.agent = await runProcess({
      command: options.piCommand ?? "pi",
      args: buildPiArgs({ ...options, requiredExtensions }),
      cwd: worktree,
      env,
      timeoutMs: (options.task.agentTimeoutSeconds ?? DEFAULT_AGENT_TIMEOUT_SECONDS) * 1_000,
      stdoutPath: join(runDirectory, "agent.jsonl"),
      stderrPath: join(runDirectory, "agent.stderr.log"),
    });
    if (!successful(result.agent)) {
      result.failureStage = "agent";
      return { result, resultPath };
    }

    result.injectedVerificationAssets = await injectVerificationAssets(verification.inject, worktree);
    result.verification = containerized
      ? await runContainerCommand(
          verification,
          runtime,
          activeContainer!,
          worktree,
          join(runDirectory, "verification.stdout.log"),
          join(runDirectory, "verification.stderr.log"),
        )
      : await runLocalCommand(
          verification,
          worktree,
          join(runDirectory, "verification.stdout.log"),
          join(runDirectory, "verification.stderr.log"),
        );
    result.passed = successful(result.verification);
    if (!result.passed) result.failureStage = "verification";
    return { result, resultPath };
  } catch (error) {
    result.failureStage ??= "executor";
    result.error = error instanceof Error ? error.message : String(error);
    return { result, resultPath };
  } finally {
    result.finishedAt = new Date().toISOString();
    const containerStop = await stop();
    if (containerStop && !successful(containerStop)) {
      result.containerCleanupError = containerStop.stderrTail || containerStop.stdoutTail;
    }
    if (!options.keepWorktree && !activeContainer) {
      const cleanup = await git(options.repository.path, ["worktree", "remove", "--force", worktree], 120_000);
      if (!successful(cleanup)) result.cleanupError = cleanup.stderrTail || cleanup.stdoutTail;
      await rm(temporaryRoot, { recursive: true, force: true });
    } else if (!options.keepWorktree && activeContainer) {
      result.cleanupError = `Worktree preserved because container ${activeContainer} could not be stopped: ${worktree}`;
      result.worktree = worktree;
    }
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
}
