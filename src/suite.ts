import type { EvaluationResult, EvaluationSuite } from "./types.ts";

export type SuiteSplit = "diagnosis" | "validation" | "test";

export interface SuiteTaskResult {
  taskId: string;
  trial: number;
  passed: boolean;
  resultPath?: string;
  runId?: string;
  cost?: number;
  durationMs?: number;
  toolCalls?: number;
  toolErrors?: number;
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
  trials: number;
  totalCost: number;
  invalidReason?: string;
  tasks: SuiteTaskResult[];
}

export function taskIdsForSplit(suite: EvaluationSuite, split: SuiteSplit): string[] {
  return suite[split];
}

export function suiteTaskResult(result: EvaluationResult, resultPath: string, trial = 1): SuiteTaskResult {
  return {
    taskId: result.taskId,
    trial,
    passed: result.passed,
    resultPath,
    runId: result.runId,
    cost: result.trace?.usage.cost,
    durationMs: Date.parse(result.finishedAt) - Date.parse(result.startedAt),
    toolCalls: result.trace?.toolCalls,
    toolErrors: result.trace?.toolErrors,
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
  trials?: number;
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
    trials: input.trials ?? Math.max(0, ...input.tasks.map((task) => task.trial)),
    totalCost: input.tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0),
    tasks: input.tasks,
  };
}
