import { join } from "node:path";
import type { SuiteComparison } from "./comparison.ts";
import type { SuiteSplit } from "./suite.ts";

export interface ScreeningStep {
  sequence: number;
  taskId: string;
  profileId: string;
}

export interface ScreeningExecution extends ScreeningStep {
  passed: boolean;
  resultPath?: string;
  error?: string;
}

export interface ScreeningRanking {
  rank: number;
  candidateProfileId: string;
  disposition: "retain-for-full-experiment" | "drop";
  comparisonPath: string;
  comparison: SuiteComparison;
}

export interface ScreeningSummary {
  version: 1;
  screeningOnly: true;
  runId: string;
  suiteId: string;
  split: SuiteSplit;
  model: string;
  thinking?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "invalid";
  invalidReason?: string;
  baselineProfileId: string;
  baselineProfileSha256: string;
  baselineSummaryPath: string;
  candidateProfiles: Array<{
    id: string;
    sha256: string;
    summaryPath: string;
    comparisonPath: string;
  }>;
  executions: ScreeningExecution[];
  ranking?: ScreeningRanking[];
}

export function buildScreeningPlan(taskIds: string[], profileIds: string[]): ScreeningStep[] {
  if (!taskIds.length) throw new Error("Screening requires at least one task");
  if (profileIds.length < 2) throw new Error("Screening requires a baseline and at least one candidate");
  if (new Set(profileIds).size !== profileIds.length) throw new Error("Screening profile ids must be unique");

  const plan: ScreeningStep[] = [];
  for (let taskIndex = 0; taskIndex < taskIds.length; taskIndex++) {
    const offset = taskIndex % profileIds.length;
    for (let profileIndex = 0; profileIndex < profileIds.length; profileIndex++) {
      plan.push({
        sequence: plan.length + 1,
        taskId: taskIds[taskIndex],
        profileId: profileIds[(offset + profileIndex) % profileIds.length],
      });
    }
  }
  return plan;
}

function sortableFraction(value: number | undefined): number {
  return value ?? Number.POSITIVE_INFINITY;
}

function hasImprovementSignal(comparison: SuiteComparison): boolean {
  return (
    comparison.correctnessImprovements.length > 0 ||
    (comparison.delta.costFraction !== undefined && comparison.delta.costFraction < 0) ||
    (comparison.delta.durationFraction !== undefined && comparison.delta.durationFraction < 0) ||
    comparison.delta.toolErrors < 0
  );
}

export function rankScreeningComparisons(
  entries: Array<{ comparisonPath: string; comparison: SuiteComparison }>,
  retain: number,
): ScreeningRanking[] {
  if (!Number.isInteger(retain) || retain < 1) throw new Error("Screening retain count must be positive");
  const ordered = [...entries].sort((left, right) => {
    const a = left.comparison;
    const b = right.comparison;
    const aRejected = a.recommendation === "reject" ? 1 : 0;
    const bRejected = b.recommendation === "reject" ? 1 : 0;
    const aLacksSignal = hasImprovementSignal(a) ? 0 : 1;
    const bLacksSignal = hasImprovementSignal(b) ? 0 : 1;
    return (
      aRejected - bRejected ||
      aLacksSignal - bLacksSignal ||
      a.correctnessRegressions.length - b.correctnessRegressions.length ||
      (a.candidate.attempts - a.candidate.passed) - (b.candidate.attempts - b.candidate.passed) ||
      a.delta.toolErrors - b.delta.toolErrors ||
      sortableFraction(a.delta.costFraction) - sortableFraction(b.delta.costFraction) ||
      sortableFraction(a.delta.durationFraction) - sortableFraction(b.delta.durationFraction) ||
      a.candidateProfileId.localeCompare(b.candidateProfileId)
    );
  });
  let retained = 0;
  return ordered.map((entry, index) => {
    const eligible =
      entry.comparison.recommendation !== "reject" && hasImprovementSignal(entry.comparison) && retained < retain;
    if (eligible) retained++;
    return {
      rank: index + 1,
      candidateProfileId: entry.comparison.candidateProfileId,
      disposition: eligible ? "retain-for-full-experiment" : "drop",
      comparisonPath: entry.comparisonPath,
      comparison: entry.comparison,
    };
  });
}

export function screeningSummaryPaths(directory: string, candidateIds: string[]): {
  baseline: string;
  screening: string;
  candidates: Map<string, { summary: string; comparison: string }>;
} {
  return {
    baseline: join(directory, "baseline-summary.json"),
    screening: join(directory, "screening.json"),
    candidates: new Map(candidateIds.map((id, index) => [id, {
      summary: join(directory, `candidate-${index + 1}-summary.json`),
      comparison: join(directory, `candidate-${index + 1}-comparison.json`),
    }])),
  };
}
