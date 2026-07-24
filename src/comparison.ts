import type { SuiteRunSummary, SuiteTaskResult } from "./suite.ts";

const COST_REGRESSION_LIMIT = 0.05;
const COST_IMPROVEMENT_MINIMUM = 0.05;
const DURATION_REGRESSION_LIMIT = 0.10;
const DURATION_IMPROVEMENT_MINIMUM = 0.10;

export type ComparisonRecommendation =
  | "reject"
  | "collect-more-trials"
  | "advance-to-validation"
  | "eligible-for-locked-test"
  | "promotion-eligible";

interface Totals {
  passed: number;
  attempts: number;
  cost: number;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
}

export interface SuiteComparison {
  version: 1;
  suiteId: string;
  split: SuiteRunSummary["split"];
  model: string;
  baselineProfileId: string;
  candidateProfileId: string;
  trials: number;
  minimumTrials: number;
  baseline: Totals;
  candidate: Totals;
  delta: {
    passed: number;
    cost: number;
    costFraction?: number;
    durationMs: number;
    durationFraction?: number;
    toolCalls: number;
    toolErrors: number;
  };
  correctnessRegressions: Array<{ taskId: string; trial: number }>;
  correctnessImprovements: Array<{ taskId: string; trial: number }>;
  recommendation: ComparisonRecommendation;
  reasons: string[];
}

function normalizedTasks(summary: SuiteRunSummary): SuiteTaskResult[] {
  return summary.tasks.map((task) => ({ ...task, trial: task.trial ?? 1 }));
}

function key(task: SuiteTaskResult): string {
  return `${task.trial}:${task.taskId}`;
}

function totals(tasks: SuiteTaskResult[]): Totals {
  return {
    passed: tasks.filter((task) => task.passed).length,
    attempts: tasks.length,
    cost: tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0),
    durationMs: tasks.reduce((sum, task) => sum + (task.durationMs ?? 0), 0),
    toolCalls: tasks.reduce((sum, task) => sum + (task.toolCalls ?? 0), 0),
    toolErrors: tasks.reduce((sum, task) => sum + (task.toolErrors ?? 0), 0),
  };
}

function fraction(candidate: number, baseline: number): number | undefined {
  return baseline === 0 ? undefined : (candidate - baseline) / baseline;
}

export function compareSuiteRuns(
  baselineSummary: SuiteRunSummary,
  candidateSummary: SuiteRunSummary,
  minimumTrials = 3,
): SuiteComparison {
  for (const field of ["suiteId", "split", "model", "thinking"] as const) {
    if (baselineSummary[field] !== candidateSummary[field]) {
      throw new Error(`Suite summaries differ on ${field}`);
    }
  }
  if (baselineSummary.profileId === candidateSummary.profileId) {
    throw new Error("Baseline and candidate profiles must differ");
  }
  if (!Number.isInteger(minimumTrials) || minimumTrials < 1) throw new Error("minimumTrials must be a positive integer");

  const baselineTasks = normalizedTasks(baselineSummary);
  const candidateTasks = normalizedTasks(candidateSummary);
  const baselineByKey = new Map(baselineTasks.map((task) => [key(task), task]));
  const candidateByKey = new Map(candidateTasks.map((task) => [key(task), task]));
  if (baselineByKey.size !== baselineTasks.length || candidateByKey.size !== candidateTasks.length) {
    throw new Error("Suite summaries contain duplicate task/trial pairs");
  }
  if (
    baselineByKey.size !== candidateByKey.size ||
    [...baselineByKey.keys()].some((taskKey) => !candidateByKey.has(taskKey))
  ) {
    throw new Error("Suite summaries do not contain the same task/trial pairs");
  }
  const taskIds = new Set(baselineTasks.map((task) => task.taskId));
  const trialIds = new Set(baselineTasks.map((task) => task.trial));
  if (baselineTasks.length !== taskIds.size * trialIds.size) {
    throw new Error("Suite summaries do not contain a complete task/trial matrix");
  }

  const regressions: SuiteComparison["correctnessRegressions"] = [];
  const improvements: SuiteComparison["correctnessImprovements"] = [];
  for (const [taskKey, baseline] of baselineByKey) {
    const candidate = candidateByKey.get(taskKey)!;
    const item = { taskId: baseline.taskId, trial: baseline.trial };
    if (baseline.passed && !candidate.passed) regressions.push(item);
    if (!baseline.passed && candidate.passed) improvements.push(item);
  }

  const baseline = totals(baselineTasks);
  const candidate = totals(candidateTasks);
  const costFraction = fraction(candidate.cost, baseline.cost);
  const durationFraction = fraction(candidate.durationMs, baseline.durationMs);
  const trials = trialIds.size;
  const reasons: string[] = [];
  let recommendation: ComparisonRecommendation;

  if (regressions.length || candidate.passed !== candidate.attempts) {
    recommendation = "reject";
    reasons.push(regressions.length ? "candidate regressed correctness" : "candidate did not pass every attempt");
  } else if (
    improvements.length === 0 &&
    ((costFraction !== undefined && costFraction > COST_REGRESSION_LIMIT) ||
      (durationFraction !== undefined && durationFraction > DURATION_REGRESSION_LIMIT) ||
      candidate.toolErrors > baseline.toolErrors)
  ) {
    recommendation = "reject";
    reasons.push("candidate regressed an efficiency guardrail");
  } else if (trials < minimumTrials) {
    recommendation = "collect-more-trials";
    reasons.push(`only ${trials} paired trial(s); ${minimumTrials} required`);
  } else {
    const materiallyImproved =
      improvements.length > 0 ||
      (costFraction !== undefined && costFraction <= -COST_IMPROVEMENT_MINIMUM) ||
      (durationFraction !== undefined && durationFraction <= -DURATION_IMPROVEMENT_MINIMUM) ||
      candidate.toolErrors < baseline.toolErrors;
    if (baselineSummary.split === "diagnosis" && !materiallyImproved) {
      recommendation = "reject";
      reasons.push("candidate has no material measured diagnosis improvement");
    } else if (baselineSummary.split === "diagnosis") {
      recommendation = "advance-to-validation";
      reasons.push("candidate cleared diagnosis correctness and efficiency gates");
    } else if (baselineSummary.split === "validation") {
      recommendation = "eligible-for-locked-test";
      reasons.push("candidate cleared validation correctness and efficiency gates");
    } else {
      recommendation = "promotion-eligible";
      reasons.push("candidate cleared the locked-test correctness and efficiency gates");
    }
  }

  return {
    version: 1,
    suiteId: baselineSummary.suiteId,
    split: baselineSummary.split,
    model: baselineSummary.model,
    baselineProfileId: baselineSummary.profileId,
    candidateProfileId: candidateSummary.profileId,
    trials,
    minimumTrials,
    baseline,
    candidate,
    delta: {
      passed: candidate.passed - baseline.passed,
      cost: candidate.cost - baseline.cost,
      costFraction,
      durationMs: candidate.durationMs - baseline.durationMs,
      durationFraction,
      toolCalls: candidate.toolCalls - baseline.toolCalls,
      toolErrors: candidate.toolErrors - baseline.toolErrors,
    },
    correctnessRegressions: regressions,
    correctnessImprovements: improvements,
    recommendation,
    reasons,
  };
}
