import { describe, expect, it } from "vitest";
import { evaluatorInfrastructureFailure } from "../src/infrastructure.ts";
import type { EvaluationResult, ProcessResult } from "../src/types.ts";

function result(overrides: Partial<EvaluationResult>): EvaluationResult {
  return {
    version: 1,
    runId: "run",
    taskId: "task",
    repositoryId: "repo",
    profileId: "profile",
    model: "provider/model",
    executor: "container",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    passed: false,
    sourceRevision: "abc",
    ...overrides,
  };
}

function process(stderrTail: string): ProcessResult {
  return {
    command: "docker",
    args: [],
    code: 1,
    signal: null,
    timedOut: false,
    durationMs: 1,
    stdoutTail: "",
    stderrTail,
  };
}

describe("evaluator infrastructure failures", () => {
  it("recognizes executor and container cleanup failures", () => {
    expect(evaluatorInfrastructureFailure(result({ failureStage: "executor", error: "daemon unavailable" })))
      .toBe("daemon unavailable");
    expect(evaluatorInfrastructureFailure(result({ containerCleanupError: "socket disappeared" })))
      .toBe("socket disappeared");
  });

  it("recognizes a runtime disconnect during verification", () => {
    expect(evaluatorInfrastructureFailure(result({
      failureStage: "verification",
      verification: process('error during connect: Get "docker.sock": EOF'),
    }))).toContain("error during connect");
  });

  it("does not classify ordinary verifier failures as infrastructure", () => {
    expect(evaluatorInfrastructureFailure(result({
      failureStage: "verification",
      verification: process("AssertionError: expected true"),
    }))).toBeUndefined();
  });
});
