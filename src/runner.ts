import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  ReverificationResult,
  TaskDefinition,
  VerificationAsset,
  VerificationSpec,
} from "./types.ts";
import { runProcess, runShell } from "./process.ts";
import { summarizeTrace } from "./trace.ts";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 900;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
const CONTAINER_TOOL_NAMES = new Set(["read", "bash", "edit", "write"]);
const CONTAINER_EXTENSION = fileURLToPath(new URL("../extension/container-tools.ts", import.meta.url));

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

export function buildContainerName(runId: string, phase: "setup" | "agent"): string {
  const hash = createHash("sha256").update(runId).digest("hex").slice(0, 8);
  const prefix = "psh-";
  const suffix = `-${hash}-${phase}`;
  const body = safeId(runId).slice(0, 63 - prefix.length - suffix.length);
  return `${prefix}${body}${suffix}`;
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

async function git(
  repositoryPath: string,
  args: string[],
  timeoutMs = 60_000,
  stdoutPath?: string,
): Promise<ProcessResult> {
  return runProcess({
    command: "git",
    args: ["-C", repositoryPath, ...args],
    cwd: repositoryPath,
    timeoutMs,
    stdoutPath,
  });
}

function successful(result: ProcessResult): boolean {
  return result.code === 0 && !result.timedOut;
}

export async function removeTemporaryRoot(path: string): Promise<void> {
  // Go's module cache intentionally contains read-only directories.
  await runProcess({ command: "chmod", args: ["-R", "u+w", path], cwd: dirname(path), timeoutMs: 120_000 });
  await rm(path, { recursive: true, force: true });
}

interface IsolatedGit {
  originalLink: string;
  baselineCommit: string;
}

async function isolateWorktreeGit(worktree: string): Promise<IsolatedGit> {
  const gitPath = join(worktree, ".git");
  const originalLink = await readFile(gitPath, "utf8");
  await rm(gitPath, { force: true });
  try {
    for (const args of [
      ["init", "--quiet", "--initial-branch=main"],
      ["add", "--all"],
      ["-c", "user.name=Pi Self Harness", "-c", "user.email=self-harness@invalid", "commit", "--quiet", "-m", "Evaluation baseline"],
    ]) {
      const result = await git(worktree, args, 120_000);
      if (!successful(result)) throw new Error(`Could not isolate evaluation Git state: ${result.stderrTail || result.stdoutTail}`);
    }
    const baseline = await git(worktree, ["rev-parse", "HEAD"]);
    if (!successful(baseline)) throw new Error(`Could not resolve isolated baseline: ${baseline.stderrTail}`);
    return { originalLink, baselineCommit: baseline.stdoutTail.trim() };
  } catch (error) {
    await rm(gitPath, { recursive: true, force: true });
    await writeFile(gitPath, originalLink);
    throw error;
  }
}

async function captureAgentPatch(worktree: string, baselineCommit: string, runDirectory: string): Promise<void> {
  const intent = await git(worktree, ["add", "--intent-to-add", "--all"]);
  if (!successful(intent)) throw new Error(`Could not stage untracked paths for diff capture: ${intent.stderrTail}`);
  const patch = await git(worktree, ["diff", "--binary", baselineCommit, "--", "."], 120_000, join(runDirectory, "agent.patch"));
  if (!successful(patch)) throw new Error(`Could not capture agent patch: ${patch.stderrTail}`);
  const status = await git(worktree, ["status", "--short"], 60_000, join(runDirectory, "agent-status.txt"));
  if (!successful(status)) throw new Error(`Could not capture agent status: ${status.stderrTail}`);
}

async function restoreWorktreeGit(worktree: string, originalLink: string): Promise<void> {
  await rm(join(worktree, ".git"), { recursive: true, force: true });
  await writeFile(join(worktree, ".git"), originalLink);
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
    await removeTemporaryRoot(temporaryRoot);
    throw new Error(`Could not create worktree: ${worktreeResult.stderrTail}`);
  }
  let isolatedGit: IsolatedGit;
  try {
    isolatedGit = await isolateWorktreeGit(worktree);
  } catch (error) {
    await git(options.repository.path, ["worktree", "remove", "--force", worktree], 120_000);
    await removeTemporaryRoot(temporaryRoot);
    throw error;
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
  const runtime = executor.runtime ?? (process.platform === "darwin" ? "docker" : "podman");
  const piVersion = await runProcess({
    command: options.piCommand ?? "pi",
    args: ["--version"],
    cwd: worktree,
    timeoutMs: 30_000,
  });
  if (successful(piVersion)) result.piVersion = piVersion.stdoutTail.trim();
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
    if (!result.containerImageId) {
      const inspected = await runProcess({
        command: runtime,
        args: ["image", "inspect", "--format", "{{.Id}}", executor.image!],
        cwd: worktree,
        timeoutMs: 30_000,
      });
      if (successful(inspected)) result.containerImageId = inspected.stdoutTail.trim();
    }
  };
  const stop = async (): Promise<ProcessResult | undefined> => {
    if (!activeContainer) return undefined;
    const stopped = await stopContainer(runtime, activeContainer, worktree);
    if (successful(stopped)) activeContainer = undefined;
    return stopped;
  };

  try {
    if (containerized && options.task.setup) {
      await start(buildContainerName(runId, "setup"), executor.setupNetwork ?? "bridge");
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

    if (containerized) await start(buildContainerName(runId, "agent"), executor.agentNetwork ?? "none");

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
    const agentTracePath = join(runDirectory, "agent.jsonl");
    result.agent = await runProcess({
      command: options.piCommand ?? "pi",
      args: buildPiArgs({ ...options, requiredExtensions }),
      cwd: worktree,
      env,
      timeoutMs: (options.task.agentTimeoutSeconds ?? DEFAULT_AGENT_TIMEOUT_SECONDS) * 1_000,
      stdoutPath: agentTracePath,
      stderrPath: join(runDirectory, "agent.stderr.log"),
      captureTail: false,
    });
    result.trace = await summarizeTrace(agentTracePath);
    await captureAgentPatch(worktree, isolatedGit.baselineCommit, runDirectory);
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
    try {
      await restoreWorktreeGit(worktree, isolatedGit.originalLink);
    } catch (error) {
      result.cleanupError = `Could not restore worktree Git metadata: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!options.keepWorktree && !activeContainer && !result.cleanupError) {
      const cleanup = await git(options.repository.path, ["worktree", "remove", "--force", worktree], 120_000);
      if (successful(cleanup)) {
        try {
          await removeTemporaryRoot(temporaryRoot);
        } catch (error) {
          result.cleanupError = `Could not remove temporary cache: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        result.cleanupError = cleanup.stderrTail || cleanup.stdoutTail;
        result.worktree = worktree;
      }
    } else if (!options.keepWorktree) {
      result.cleanupError ??= activeContainer
        ? `Worktree preserved because container ${activeContainer} could not be stopped: ${worktree}`
        : `Worktree preserved after cleanup failure: ${worktree}`;
      result.worktree = worktree;
    }
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
}

export interface ReverifyOptions {
  originalResultPath: string;
  task: TaskDefinition;
  taskManifestPath: string;
  repository: RepositoryDefinition;
  keepWorktree?: boolean;
  allowUnsandboxedVerifier: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function verifierFingerprint(verification: VerificationSpec): Promise<string> {
  const assets = [];
  for (const asset of verification.inject ?? []) {
    assets.push({ destination: asset.destination, sha256: sha256(await readFile(asset.source)) });
  }
  return sha256(JSON.stringify({
    command: verification.command,
    timeoutSeconds: verification.timeoutSeconds,
    assets,
  }));
}

function parseOriginalResult(value: string, path: string): EvaluationResult {
  const parsed = JSON.parse(value) as Partial<EvaluationResult>;
  if (
    parsed.version !== 1 ||
    typeof parsed.runId !== "string" ||
    typeof parsed.taskId !== "string" ||
    typeof parsed.repositoryId !== "string" ||
    typeof parsed.sourceRevision !== "string" ||
    (parsed.executor !== "local" && parsed.executor !== "container")
  ) {
    throw new Error(`Invalid evaluation result: ${path}`);
  }
  return parsed as EvaluationResult;
}

export async function reverify(options: ReverifyOptions): Promise<{ result: ReverificationResult; resultPath: string }> {
  const originalResultPath = resolve(options.originalResultPath);
  const originalResultText = await readFile(originalResultPath, "utf8");
  const original = parseOriginalResult(originalResultText, originalResultPath);
  if (original.taskId !== options.task.id) throw new Error(`Result task ${original.taskId} does not match ${options.task.id}`);
  if (original.repositoryId !== options.repository.id) {
    throw new Error(`Result repository ${original.repositoryId} does not match ${options.repository.id}`);
  }

  const verification = options.task.verification ?? options.repository.defaultVerification;
  if (!verification) throw new Error(`Task ${options.task.id} has no verification command`);
  if (options.task.setup) assertCommandAllowed(options.task.setup.command, options.repository);
  assertCommandAllowed(verification.command, options.repository);

  const executor = mergeExecutor(options.repository.executor, options.task.executor);
  assertExecutorCompatible(executor);
  const containerized = executor.type === "container";
  if (original.executor !== executor.type) {
    throw new Error(`Original executor ${original.executor} does not match current executor ${executor.type}`);
  }
  if (containerized && !original.containerImageId) {
    throw new Error("Original container result has no image digest; safe reverification is unavailable");
  }
  if (containerized && original.containerImage && original.containerImage !== executor.image) {
    throw new Error(`Original image ${original.containerImage} does not match current image ${executor.image}`);
  }
  if (!containerized && !options.allowUnsandboxedVerifier) {
    throw new Error(
      "Local verification is not sandboxed. Pass --allow-unsandboxed-verifier only after reviewing the task and captured patch.",
    );
  }

  const agentPatchPath = join(dirname(originalResultPath), "agent.patch");
  const agentPatch = await readFile(agentPatchPath);
  const taskManifestPath = resolve(options.taskManifestPath);
  const taskManifest = await readFile(taskManifestPath);
  const verifierSha256 = await verifierFingerprint(verification);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reverificationId = `${timestamp}_${verifierSha256.slice(0, 12)}`;
  const reverificationsDirectory = join(dirname(originalResultPath), "reverifications");
  const outputDirectory = join(reverificationsDirectory, reverificationId);
  await mkdir(reverificationsDirectory, { recursive: true });
  await mkdir(outputDirectory);
  const resultPath = join(outputDirectory, "result.json");
  const startedAt = new Date().toISOString();
  const result: ReverificationResult = {
    version: 1,
    reverificationId,
    originalResultPath,
    originalResultSha256: sha256(originalResultText),
    agentPatchPath,
    agentPatchSha256: sha256(agentPatch),
    taskManifestPath,
    taskManifestSha256: sha256(taskManifest),
    verifierSha256,
    taskId: options.task.id,
    repositoryId: options.repository.id,
    sourceRevision: original.sourceRevision,
    executor: executor.type ?? "local",
    containerImage: containerized ? executor.image : undefined,
    startedAt,
    finishedAt: startedAt,
    passed: false,
  };

  const revisionResult = await git(options.repository.path, ["rev-parse", "--verify", `${original.sourceRevision}^{commit}`]);
  if (!successful(revisionResult) || revisionResult.stdoutTail.trim() !== original.sourceRevision) {
    result.failureStage = "executor";
    result.error = `Could not resolve original source revision ${original.sourceRevision}`;
    result.finishedAt = new Date().toISOString();
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return { result, resultPath };
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-self-harness-reverify-"));
  const worktree = join(temporaryRoot, "worktree");
  const cacheDirectory = join(temporaryRoot, "cache");
  await mkdir(cacheDirectory, { recursive: true });
  const worktreeResult = await git(
    options.repository.path,
    ["worktree", "add", "--detach", worktree, original.sourceRevision],
    120_000,
  );
  if (!successful(worktreeResult)) {
    result.failureStage = "executor";
    result.error = `Could not create worktree: ${worktreeResult.stderrTail}`;
    result.finishedAt = new Date().toISOString();
    await removeTemporaryRoot(temporaryRoot);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return { result, resultPath };
  }
  if (options.keepWorktree) result.worktree = worktree;

  const runtime = executor.runtime ?? (process.platform === "darwin" ? "docker" : "podman");
  let activeContainer: string | undefined;
  const start = async (phase: "setup" | "agent", network: "none" | "bridge") => {
    const name = buildContainerName(reverificationId, phase);
    const started = await startContainer({
      runtime,
      image: executor.image!,
      name,
      worktree,
      cacheDirectory,
      network,
    }, worktree);
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
    if (containerized) {
      const inspected = await runProcess({
        command: runtime,
        args: ["image", "inspect", "--format", "{{.Id}}", executor.image!],
        cwd: worktree,
        timeoutMs: 30_000,
      });
      if (!successful(inspected)) throw new Error(`Could not inspect container image ${executor.image}`);
      result.containerImageId = inspected.stdoutTail.trim();
      if (original.containerImageId && original.containerImageId !== result.containerImageId) {
        throw new Error(`Container image digest changed: ${original.containerImageId} != ${result.containerImageId}`);
      }
    }

    if (containerized && options.task.setup) {
      await start("setup", executor.setupNetwork ?? "bridge");
      result.setup = await runContainerCommand(
        options.task.setup,
        runtime,
        activeContainer!,
        worktree,
        join(outputDirectory, "setup.stdout.log"),
        join(outputDirectory, "setup.stderr.log"),
      );
      const setupStop = await stop();
      if (setupStop && !successful(setupStop)) throw new Error(`Could not stop setup container: ${setupStop.stderrTail}`);
      if (!successful(result.setup)) {
        result.failureStage = "setup";
        return { result, resultPath };
      }
    } else if (options.task.setup) {
      result.setup = await runLocalCommand(
        options.task.setup,
        worktree,
        join(outputDirectory, "setup.stdout.log"),
        join(outputDirectory, "setup.stderr.log"),
      );
      if (!successful(result.setup)) {
        result.failureStage = "setup";
        return { result, resultPath };
      }
    }

    if (agentPatch.length) {
      result.patchApplication = await git(
        worktree,
        ["apply", "--binary", "--whitespace=nowarn", agentPatchPath],
        120_000,
      );
      if (!successful(result.patchApplication)) {
        result.failureStage = "patch";
        return { result, resultPath };
      }
    }

    result.injectedVerificationAssets = await injectVerificationAssets(verification.inject, worktree);
    if (containerized) await start("agent", executor.agentNetwork ?? "none");
    result.verification = containerized
      ? await runContainerCommand(
          verification,
          runtime,
          activeContainer!,
          worktree,
          join(outputDirectory, "verification.stdout.log"),
          join(outputDirectory, "verification.stderr.log"),
        )
      : await runLocalCommand(
          verification,
          worktree,
          join(outputDirectory, "verification.stdout.log"),
          join(outputDirectory, "verification.stderr.log"),
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
      if (successful(cleanup)) {
        try {
          await removeTemporaryRoot(temporaryRoot);
        } catch (error) {
          result.cleanupError = `Could not remove temporary cache: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        result.cleanupError = cleanup.stderrTail || cleanup.stdoutTail;
        result.worktree = worktree;
      }
    } else if (!options.keepWorktree) {
      result.cleanupError = `Worktree preserved because container cleanup failed: ${worktree}`;
      result.worktree = worktree;
    }
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
}
