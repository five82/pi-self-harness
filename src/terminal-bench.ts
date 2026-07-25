import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

interface TrialIdentity {
  provider: string;
  model: string;
  piVersion: string;
  extensionSha256: string;
  benchmarkProvenanceSha256: string;
  benchmarkSourceRevision: string;
  thinking?: string;
  profileSha256: string;
}

export interface TerminalBenchTrial extends TrialIdentity {
  taskName: string;
  taskChecksum: string;
  reward: number;
  costUsd?: number;
  durationMs: number;
}

export interface TerminalBenchJobSummary extends TrialIdentity {
  version: 1;
  jobResultPath: string;
  trials: TerminalBenchTrial[];
  totalReward: number;
  meanReward: number;
  totalCostUsd?: number;
  totalDurationMs: number;
}

export interface TerminalBenchComparison {
  version: 1;
  baselineJobResultPath: string;
  candidateJobResultPath: string;
  provider: string;
  model: string;
  thinking?: string;
  piVersion: string;
  extensionSha256: string;
  benchmarkProvenanceSha256: string;
  benchmarkSourceRevision: string;
  baselineProfileSha256: string;
  candidateProfileSha256: string;
  tasks: Array<{
    taskName: string;
    attempts: number;
    baselineMeanReward: number;
    candidateMeanReward: number;
    rewardDelta: number;
  }>;
  baselineMeanReward: number;
  candidateMeanReward: number;
  rewardDelta: number;
  baselineCostUsd?: number;
  candidateCostUsd?: number;
  costDeltaFraction?: number;
  baselineDurationMs: number;
  candidateDurationMs: number;
  maxCostRegressionFraction: number;
  passed: boolean;
  reasons: string[];
  warnings: string[];
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context}: expected object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${context}: expected non-empty string`);
  return value;
}

function number(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${context}: expected finite number`);
  return value;
}

function optionalNumber(value: unknown, context: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return number(value, context);
}

function trialFromJson(value: unknown, path: string): TerminalBenchTrial {
  const trial = object(value, path);
  if (trial.exception_info !== null && trial.exception_info !== undefined) throw new Error(`${path}: trial has an exception`);
  const agentInfo = object(trial.agent_info, `${path}.agent_info`);
  if (agentInfo.name !== "pi-host") throw new Error(`${path}: expected pi-host agent`);
  const modelInfo = object(agentInfo.model_info, `${path}.agent_info.model_info`);
  const agentResult = object(trial.agent_result, `${path}.agent_result`);
  const metadata = object(agentResult.metadata, `${path}.agent_result.metadata`);
  const verifier = object(trial.verifier_result, `${path}.verifier_result`);
  const rewards = object(verifier.rewards, `${path}.verifier_result.rewards`);
  const timing = object(trial.agent_execution, `${path}.agent_execution`);
  const started = Date.parse(string(timing.started_at, `${path}.agent_execution.started_at`));
  const finished = Date.parse(string(timing.finished_at, `${path}.agent_execution.finished_at`));
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    throw new Error(`${path}: invalid agent timing`);
  }
  const thinking = metadata.thinking;
  if (thinking !== null && thinking !== undefined && typeof thinking !== "string") {
    throw new Error(`${path}.agent_result.metadata.thinking: expected string or null`);
  }
  return {
    taskName: string(trial.task_name, `${path}.task_name`),
    taskChecksum: string(trial.task_checksum, `${path}.task_checksum`),
    reward: number(rewards.reward, `${path}.verifier_result.rewards.reward`),
    costUsd: optionalNumber(agentResult.cost_usd, `${path}.agent_result.cost_usd`),
    durationMs: finished - started,
    provider: string(modelInfo.provider, `${path}.agent_info.model_info.provider`),
    model: string(modelInfo.name, `${path}.agent_info.model_info.name`),
    piVersion: string(metadata.pi_version, `${path}.agent_result.metadata.pi_version`),
    extensionSha256: string(metadata.extension_sha256, `${path}.agent_result.metadata.extension_sha256`),
    benchmarkProvenanceSha256: string(
      metadata.benchmark_provenance_sha256,
      `${path}.agent_result.metadata.benchmark_provenance_sha256`,
    ),
    benchmarkSourceRevision: string(
      metadata.benchmark_source_revision,
      `${path}.agent_result.metadata.benchmark_source_revision`,
    ),
    thinking: thinking ?? undefined,
    profileSha256: string(metadata.profile_sha256, `${path}.agent_result.metadata.profile_sha256`),
  };
}

function assertSameIdentity(first: TrialIdentity, trial: TrialIdentity, context: string): void {
  for (const key of [
    "provider",
    "model",
    "piVersion",
    "extensionSha256",
    "benchmarkProvenanceSha256",
    "benchmarkSourceRevision",
    "thinking",
    "profileSha256",
  ] as const) {
    if (first[key] !== trial[key]) throw new Error(`${context}: inconsistent ${key}`);
  }
}

export async function loadTerminalBenchJob(path: string): Promise<TerminalBenchJobSummary> {
  const input = resolve(path);
  const resultPath = basename(input) === "result.json" ? input : join(input, "result.json");
  if (!existsSync(resultPath)) throw new Error(`Harbor job result not found: ${resultPath}`);
  const job = object(JSON.parse(await readFile(resultPath, "utf8")), resultPath);
  const stats = object(job.stats, `${resultPath}.stats`);
  const total = number(job.n_total_trials, `${resultPath}.n_total_trials`);
  if (number(stats.n_completed_trials, `${resultPath}.stats.n_completed_trials`) !== total) {
    throw new Error(`${resultPath}: Harbor job is incomplete`);
  }
  if (number(stats.n_errored_trials, `${resultPath}.stats.n_errored_trials`) !== 0) {
    throw new Error(`${resultPath}: Harbor job contains errored trials`);
  }

  const jobDirectory = dirname(resultPath);
  const entries = await readdir(jobDirectory, { withFileTypes: true });
  const trialPaths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(jobDirectory, entry.name, "result.json"))
    .filter(existsSync)
    .sort();
  if (trialPaths.length !== total || total < 1) {
    throw new Error(`${resultPath}: expected ${total} trial results, found ${trialPaths.length}`);
  }
  const trials = await Promise.all(
    trialPaths.map(async (trialPath) => trialFromJson(JSON.parse(await readFile(trialPath, "utf8")), trialPath)),
  );
  const identity = trials[0];
  for (const trial of trials.slice(1)) assertSameIdentity(identity, trial, resultPath);
  const costs = trials.map((trial) => trial.costUsd);
  return {
    version: 1,
    jobResultPath: resultPath,
    trials,
    provider: identity.provider,
    model: identity.model,
    piVersion: identity.piVersion,
    extensionSha256: identity.extensionSha256,
    benchmarkProvenanceSha256: identity.benchmarkProvenanceSha256,
    benchmarkSourceRevision: identity.benchmarkSourceRevision,
    thinking: identity.thinking,
    profileSha256: identity.profileSha256,
    totalReward: trials.reduce((sum, trial) => sum + trial.reward, 0),
    meanReward: trials.reduce((sum, trial) => sum + trial.reward, 0) / trials.length,
    totalCostUsd: costs.every((cost) => cost !== undefined) ? costs.reduce<number>((sum, cost) => sum + cost!, 0) : undefined,
    totalDurationMs: trials.reduce((sum, trial) => sum + trial.durationMs, 0),
  };
}

function grouped(job: TerminalBenchJobSummary): Map<string, TerminalBenchTrial[]> {
  const result = new Map<string, TerminalBenchTrial[]>();
  for (const trial of job.trials) result.set(trial.taskName, [...(result.get(trial.taskName) ?? []), trial]);
  return result;
}

export function compareTerminalBenchJobs(
  baseline: TerminalBenchJobSummary,
  candidate: TerminalBenchJobSummary,
  maxCostRegressionFraction = 0.1,
): TerminalBenchComparison {
  if (!Number.isFinite(maxCostRegressionFraction) || maxCostRegressionFraction < 0) {
    throw new Error("maxCostRegressionFraction must be non-negative");
  }
  for (const key of [
    "provider",
    "model",
    "piVersion",
    "extensionSha256",
    "benchmarkProvenanceSha256",
    "benchmarkSourceRevision",
    "thinking",
  ] as const) {
    if (baseline[key] !== candidate[key]) throw new Error(`Terminal-Bench jobs differ in ${key}`);
  }
  const baselineGroups = grouped(baseline);
  const candidateGroups = grouped(candidate);
  if ([...baselineGroups.keys()].sort().join("\0") !== [...candidateGroups.keys()].sort().join("\0")) {
    throw new Error("Terminal-Bench jobs contain different tasks");
  }
  const reasons: string[] = [];
  const warnings: string[] = [];
  const tasks = [...baselineGroups.keys()].sort().map((taskName) => {
    const baselineTrials = baselineGroups.get(taskName)!;
    const candidateTrials = candidateGroups.get(taskName)!;
    if (baselineTrials.length !== candidateTrials.length) throw new Error(`${taskName}: attempt counts differ`);
    if (new Set([...baselineTrials, ...candidateTrials].map((trial) => trial.taskChecksum)).size !== 1) {
      throw new Error(`${taskName}: task checksums differ`);
    }
    const baselineMeanReward = baselineTrials.reduce((sum, trial) => sum + trial.reward, 0) / baselineTrials.length;
    const candidateMeanReward = candidateTrials.reduce((sum, trial) => sum + trial.reward, 0) / candidateTrials.length;
    if (candidateMeanReward + 1e-12 < baselineMeanReward) reasons.push(`${taskName}: reward regressed`);
    return {
      taskName,
      attempts: baselineTrials.length,
      baselineMeanReward,
      candidateMeanReward,
      rewardDelta: candidateMeanReward - baselineMeanReward,
    };
  });
  const costDeltaFraction = baseline.totalCostUsd !== undefined && candidate.totalCostUsd !== undefined && baseline.totalCostUsd > 0
    ? (candidate.totalCostUsd - baseline.totalCostUsd) / baseline.totalCostUsd
    : undefined;
  if (costDeltaFraction === undefined) warnings.push("cost gate unavailable");
  else if (costDeltaFraction > maxCostRegressionFraction) reasons.push("aggregate cost exceeded regression limit");

  return {
    version: 1,
    baselineJobResultPath: baseline.jobResultPath,
    candidateJobResultPath: candidate.jobResultPath,
    provider: baseline.provider,
    model: baseline.model,
    thinking: baseline.thinking,
    piVersion: baseline.piVersion,
    extensionSha256: baseline.extensionSha256,
    benchmarkProvenanceSha256: baseline.benchmarkProvenanceSha256,
    benchmarkSourceRevision: baseline.benchmarkSourceRevision,
    baselineProfileSha256: baseline.profileSha256,
    candidateProfileSha256: candidate.profileSha256,
    tasks,
    baselineMeanReward: baseline.meanReward,
    candidateMeanReward: candidate.meanReward,
    rewardDelta: candidate.meanReward - baseline.meanReward,
    baselineCostUsd: baseline.totalCostUsd,
    candidateCostUsd: candidate.totalCostUsd,
    costDeltaFraction,
    baselineDurationMs: baseline.totalDurationMs,
    candidateDurationMs: candidate.totalDurationMs,
    maxCostRegressionFraction,
    passed: reasons.length === 0,
    reasons,
    warnings,
  };
}
