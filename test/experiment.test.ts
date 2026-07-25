import { describe, expect, it } from "vitest";
import { buildExperimentPlan, experimentSummaryPaths } from "../src/experiment.ts";

describe("interleaved experiments", () => {
  it("alternates profile order by task and trial", () => {
    const plan = buildExperimentPlan(["one", "two"], 2);
    const pairs = Array.from({ length: plan.length / 2 }, (_, index) =>
      plan.slice(index * 2, index * 2 + 2).map((step) => `${step.taskId}:${step.trial}:${step.profile}`),
    );

    expect(pairs).toEqual([
      ["one:1:baseline", "one:1:candidate"],
      ["two:1:candidate", "two:1:baseline"],
      ["one:2:candidate", "one:2:baseline"],
      ["two:2:baseline", "two:2:candidate"],
    ]);
    expect(plan.map((step) => step.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("builds artifact paths inside the experiment directory", () => {
    expect(experimentSummaryPaths("/runs/experiment")).toEqual({
      baseline: "/runs/experiment/baseline-summary.json",
      candidate: "/runs/experiment/candidate-summary.json",
      comparison: "/runs/experiment/comparison.json",
      experiment: "/runs/experiment/experiment.json",
    });
  });
});
