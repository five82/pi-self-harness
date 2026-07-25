import { describe, expect, it } from "vitest";
import type { SuiteComparison } from "../src/comparison.ts";
import { buildScreeningPlan, rankScreeningComparisons, screeningSummaryPaths } from "../src/screening.ts";

function comparison(id: string, overrides: Partial<SuiteComparison> = {}): SuiteComparison {
  return {
    version: 1,
    suiteId: "personal",
    split: "diagnosis",
    model: "provider/model",
    baselineProfileId: "baseline",
    candidateProfileId: id,
    trials: 1,
    minimumTrials: 3,
    baseline: { passed: 2, attempts: 2, cost: 2, durationMs: 200, toolCalls: 20, toolErrors: 2 },
    candidate: { passed: 2, attempts: 2, cost: 1.8, durationMs: 180, toolCalls: 18, toolErrors: 1 },
    delta: {
      passed: 0,
      cost: -0.2,
      costFraction: -0.1,
      durationMs: -20,
      durationFraction: -0.1,
      toolCalls: -2,
      toolErrors: -1,
    },
    uncertainty: { method: "paired-bootstrap", confidence: 0.95, samples: 10_000 },
    correctnessRegressions: [],
    correctnessImprovements: [],
    recommendation: "collect-more-trials",
    reasons: ["screen"],
    ...overrides,
  };
}

describe("multi-candidate screening", () => {
  it("rotates shared baseline and candidate order by task", () => {
    const plan = buildScreeningPlan(["one", "two", "three"], ["base", "a", "b"]);
    expect(plan.map((step) => `${step.taskId}:${step.profileId}`)).toEqual([
      "one:base", "one:a", "one:b",
      "two:a", "two:b", "two:base",
      "three:b", "three:base", "three:a",
    ]);
    expect(plan.map((step) => step.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("retains only the strongest non-rejected candidates", () => {
    const ranking = rankScreeningComparisons([
      { comparisonPath: "/slow.json", comparison: comparison("slow", { delta: { ...comparison("x").delta, toolErrors: 0, costFraction: 0.04 } }) },
      { comparisonPath: "/best.json", comparison: comparison("best") },
      { comparisonPath: "/bad.json", comparison: comparison("bad", { recommendation: "reject", correctnessRegressions: [{ taskId: "one", trial: 1 }] }) },
    ], 1);

    expect(ranking.map((entry) => [entry.candidateProfileId, entry.disposition])).toEqual([
      ["best", "retain-for-full-experiment"],
      ["slow", "drop"],
      ["bad", "drop"],
    ]);
  });

  it("drops candidates without a measured improvement signal", () => {
    const noSignal = comparison("same", {
      delta: {
        passed: 0,
        cost: 0.1,
        costFraction: 0.05,
        durationMs: 10,
        durationFraction: 0.05,
        toolCalls: 0,
        toolErrors: 0,
      },
    });
    expect(rankScreeningComparisons([{ comparisonPath: "/same.json", comparison: noSignal }], 1)[0].disposition)
      .toBe("drop");
  });

  it("builds isolated artifact paths", () => {
    const paths = screeningSummaryPaths("/runs/screen", ["a"]);
    expect(paths.baseline).toBe("/runs/screen/baseline-summary.json");
    expect(paths.screening).toBe("/runs/screen/screening.json");
    expect(paths.candidates.get("a")).toEqual({
      summary: "/runs/screen/candidate-1-summary.json",
      comparison: "/runs/screen/candidate-1-comparison.json",
    });
  });
});
