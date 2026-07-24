import type { EvaluationResult, EvaluationSuite } from "./types.ts";

export type SuiteSplit = "diagnosis" | "validation" | "test";

export interface SuiteTaskResult {
  taskId: string;
  passed: boolean;
  resultPath?: string;
  runId?: string;
  cost?: number;
  durationMs?: number;
  error?: string;
}

export interface SuiteRunSummary {
  version: 1;
  suiteId: string;
  split: SuiteSplit;
  profileId: string;
  model: string;
  thinking?: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  passedTasks: number;
  totalTasks: number;
  totalCost: number;
  tasks: SuiteTaskResult[];
}

export function taskIdsForSplit(suite: EvaluationSuite, split: SuiteSplit): string[] {
  return suite[split];
}

export function suiteTaskResult(result: EvaluationResult, resultPath: string): SuiteTaskResult {
  return {
    taskId: result.taskId,
    passed: result.passed,
    resultPath,
    runId: result.runId,
    cost: result.trace?.usage.cost,
    durationMs: Date.parse(result.finishedAt) - Date.parse(result.startedAt),
  };
}

export function summarizeSuite(input: {
  suite: EvaluationSuite;
  split: SuiteSplit;
  profileId: string;
  model: string;
  thinking?: string;
  startedAt: string;
  finishedAt: string;
  tasks: SuiteTaskResult[];
}): SuiteRunSummary {
  return {
    version: 1,
    suiteId: input.suite.id,
    split: input.split,
    profileId: input.profileId,
    model: input.model,
    thinking: input.thinking,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    passed: input.tasks.length > 0 && input.tasks.every((task) => task.passed),
    passedTasks: input.tasks.filter((task) => task.passed).length,
    totalTasks: input.tasks.length,
    totalCost: input.tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0),
    tasks: input.tasks,
  };
}
