import { describe, expect, it } from "vitest";
import { summarizeSuite, suiteTaskResult, taskIdsForSplit } from "../src/suite.ts";
import type { EvaluationResult, EvaluationSuite } from "../src/types.ts";

const suite: EvaluationSuite = {
  version: 1,
  id: "personal",
  diagnosis: ["one", "two"],
  validation: ["three"],
  test: [],
};

describe("suite runs", () => {
  it("selects only the requested split", () => {
    expect(taskIdsForSplit(suite, "validation")).toEqual(["three"]);
  });

  it("aggregates outcomes and cost", () => {
    const result = {
      taskId: "one",
      runId: "run-one",
      passed: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      trace: { usage: { cost: 0.25 } },
    } as EvaluationResult;
    const task = suiteTaskResult(result, "/runs/result.json");
    const summary = summarizeSuite({
      suite,
      split: "diagnosis",
      profileId: "baseline",
      model: "provider/model",
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      tasks: [task, { taskId: "two", trial: 1, passed: false, cost: 0.5 }],
    });

    expect(task).toMatchObject({ trial: 1, durationMs: 2_000 });
    expect(summary).toMatchObject({ passed: false, passedTasks: 1, totalTasks: 2, trials: 1, totalCost: 0.75 });
  });
});
