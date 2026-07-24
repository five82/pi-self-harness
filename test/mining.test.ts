import { describe, expect, it } from "vitest";
import { buildWeaknessEvidence, extractToolErrorEvidence } from "../src/mining.ts";
import type { SuiteRunSummary } from "../src/suite.ts";
import type { EvaluationResult } from "../src/types.ts";

function summary(split: SuiteRunSummary["split"] = "diagnosis"): SuiteRunSummary {
  return {
    version: 1,
    suiteId: "personal",
    split,
    profileId: "baseline",
    model: "provider/model",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    passed: true,
    passedTasks: 1,
    totalTasks: 1,
    trials: 1,
    totalCost: 0.25,
    tasks: [{ taskId: "one", trial: 1, passed: true, resultPath: "/run/result.json" }],
  };
}

const result = {
  taskId: "one",
  profileId: "baseline",
  model: "provider/model",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:02.000Z",
  passed: true,
  trace: {
    toolCalls: 4,
    toolErrors: 1,
    toolsByName: { bash: 4 },
    toolErrorsByName: { bash: 1 },
    finalStopReason: "stop",
    finalText: "Agent-visible final report",
    usage: { cost: 0.25 },
  },
  verification: { stdoutTail: "HIDDEN VERIFIER SECRET" },
} as unknown as EvaluationResult;

describe("weakness mining", () => {
  it("extracts bounded agent-visible tool errors", () => {
    const jsonl = JSON.stringify({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "network unavailable" }] },
    });
    expect(extractToolErrorEvidence(jsonl)).toEqual([{ tool: "bash", message: "network unavailable" }]);
  });

  it("extracts only bounded agent-visible evidence", () => {
    const evidence = buildWeaknessEvidence(summary(), new Map([["/run/result.json", result]]));

    expect(evidence).toMatchObject({ attempts: 1, passedAttempts: 1, totalToolErrors: 1, totalCost: 0.25 });
    expect(evidence.tasks[0]).toMatchObject({ finalText: "Agent-visible final report", toolErrors: 1 });
    expect(JSON.stringify(evidence)).not.toContain("HIDDEN VERIFIER SECRET");
  });

  it("refuses validation and locked summaries", () => {
    expect(() => buildWeaknessEvidence(summary("validation"), new Map())).toThrow("only accepts diagnosis");
  });
});
