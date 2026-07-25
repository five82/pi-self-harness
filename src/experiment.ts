import { join } from "node:path";
import type { SuiteSplit } from "./suite.ts";
import type { SuiteComparison } from "./comparison.ts";

export type ProfileRole = "baseline" | "candidate";

export interface ExperimentStep {
  sequence: number;
  trial: number;
  taskId: string;
  profile: ProfileRole;
}

export interface ExperimentExecution extends ExperimentStep {
  profileId: string;
  passed: boolean;
  resultPath?: string;
  error?: string;
}

export interface ExperimentSummary {
  version: 1;
  runId: string;
  suiteId: string;
  split: SuiteSplit;
  model: string;
  thinking?: string;
  trials: number;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "invalid";
  invalidReason?: string;
  baselineProfileId: string;
  baselineProfileSha256: string;
  candidateProfileId: string;
  candidateProfileSha256: string;
  baselineSummaryPath: string;
  candidateSummaryPath: string;
  comparisonPath: string;
  executions: ExperimentExecution[];
  comparison?: SuiteComparison;
}

export function buildExperimentPlan(taskIds: string[], trials: number): ExperimentStep[] {
  if (!taskIds.length) throw new Error("Experiment requires at least one task");
  if (!Number.isInteger(trials) || trials < 1) throw new Error("Experiment trials must be a positive integer");

  const plan: ExperimentStep[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    for (let taskIndex = 0; taskIndex < taskIds.length; taskIndex++) {
      const baselineFirst = (trial + taskIndex) % 2 === 1;
      const order: ProfileRole[] = baselineFirst ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (const profile of order) {
        plan.push({ sequence: plan.length + 1, trial, taskId: taskIds[taskIndex], profile });
      }
    }
  }
  return plan;
}

export function experimentSummaryPaths(directory: string): {
  baseline: string;
  candidate: string;
  comparison: string;
  experiment: string;
} {
  return {
    baseline: join(directory, "baseline-summary.json"),
    candidate: join(directory, "candidate-summary.json"),
    comparison: join(directory, "comparison.json"),
    experiment: join(directory, "experiment.json"),
  };
}
