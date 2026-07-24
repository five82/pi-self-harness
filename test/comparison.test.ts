import { describe, expect, it } from "vitest";
import { compareSuiteRuns } from "../src/comparison.ts";
import type { SuiteRunSummary, SuiteTaskResult } from "../src/suite.ts";

function summary(profileId: string, tasks: SuiteTaskResult[]): SuiteRunSummary {
  return {
    version: 1,
    suiteId: "personal",
    split: "diagnosis",
    profileId,
    model: "provider/model",
    thinking: "high",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    passed: tasks.every((task) => task.passed),
    passedTasks: tasks.filter((task) => task.passed).length,
    totalTasks: tasks.length,
    trials: new Set(tasks.map((task) => task.trial)).size,
    totalCost: tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0),
    tasks,
  };
}

function attempts(cost: number): SuiteTaskResult[] {
  return [1, 2, 3].map((trial) => ({
    taskId: "task",
    trial,
    passed: true,
    cost,
    durationMs: 10_000,
    toolCalls: 10,
    toolErrors: 0,
  }));
}

describe("suite comparison", () => {
  it("advances a materially cheaper candidate after repeated diagnosis trials", () => {
    const comparison = compareSuiteRuns(summary("baseline", attempts(1)), summary("candidate", attempts(0.8)));

    expect(comparison.recommendation).toBe("advance-to-validation");
    expect(comparison.delta.costFraction).toBeCloseTo(-0.2);
    expect(comparison.trials).toBe(3);
  });

  it("prioritizes a correctness improvement over efficiency", () => {
    const baselineTasks = attempts(1);
    baselineTasks[0] = { ...baselineTasks[0], passed: false };
    const comparison = compareSuiteRuns(summary("baseline", baselineTasks), summary("candidate", attempts(2)));

    expect(comparison.recommendation).toBe("advance-to-validation");
    expect(comparison.correctnessImprovements).toEqual([{ taskId: "task", trial: 1 }]);
  });

  it("requires repeated paired trials", () => {
    const baseline = summary("baseline", attempts(1).slice(0, 1));
    const candidate = summary("candidate", attempts(0.8).slice(0, 1));

    expect(compareSuiteRuns(baseline, candidate).recommendation).toBe("collect-more-trials");
  });

  it("rejects any correctness regression", () => {
    const candidateTasks = attempts(0.8);
    candidateTasks[1] = { ...candidateTasks[1], passed: false };
    const comparison = compareSuiteRuns(summary("baseline", attempts(1)), summary("candidate", candidateTasks));

    expect(comparison.recommendation).toBe("reject");
    expect(comparison.correctnessRegressions).toEqual([{ taskId: "task", trial: 2 }]);
  });

  it("rejects unpaired summaries", () => {
    const candidateTasks = attempts(0.8).map((task) => ({ ...task, taskId: "other" }));
    expect(() => compareSuiteRuns(summary("baseline", attempts(1)), summary("candidate", candidateTasks))).toThrow(
      "same task/trial pairs",
    );
  });
});
