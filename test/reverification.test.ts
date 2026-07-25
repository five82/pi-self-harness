import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { applyReverificationOverrides, loadVerifiedReverification } from "../src/reverification.ts";
import { evaluate, reverify } from "../src/runner.ts";
import type { SuiteRunSummary } from "../src/suite.ts";
import type { EvaluationResult, HarnessProfile, RepositoryDefinition, TaskDefinition } from "../src/types.ts";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("reverification", () => {
  it("appends a current-verifier verdict without changing the original result", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-self-harness-reverify-test-"));
    const repositoryPath = join(root, "repository");
    execFileSync("mkdir", [repositoryPath]);
    git(repositoryPath, "init", "-q");
    git(repositoryPath, "config", "user.email", "test@example.com");
    git(repositoryPath, "config", "user.name", "Test");
    writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
    git(repositoryPath, "add", "README.md");
    git(repositoryPath, "commit", "-qm", "fixture");

    const fakePi = join(root, "fake-pi");
    writeFileSync(
      fakePi,
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.0.0; exit 0; fi\necho '{\"type\":\"agent_end\"}'\nprintf 'done\\n' > done.txt\n",
    );
    chmodSync(fakePi, 0o755);

    const repository: RepositoryDefinition = { id: "fixture", path: repositoryPath };
    const originalTask: TaskDefinition = {
      version: 1,
      id: "fixture-task",
      repository: "fixture",
      summary: "Fixture task",
      prompt: "Create done.txt",
      baseRevision: "HEAD",
      verification: { command: "test -f missing.txt" },
    };
    const profile: HarnessProfile = { version: 1, id: "baseline" };
    const evaluation = await evaluate({
      task: originalTask,
      repository,
      profile,
      model: "test/model",
      piCommand: fakePi,
      runsDirectory: join(root, "runs"),
      allowUnsandboxedAgent: true,
    });
    expect(evaluation.result.passed).toBe(false);
    const originalText = readFileSync(evaluation.resultPath, "utf8");

    const hiddenVerifier = join(root, "hidden.txt");
    writeFileSync(hiddenVerifier, "hidden\n");
    const taskManifestPath = join(root, "task.yaml");
    writeFileSync(taskManifestPath, "version: 1\nid: fixture-task\n");
    const currentTask: TaskDefinition = {
      ...originalTask,
      verification: {
        command: "test -f done.txt && test -f test/hidden.txt",
        inject: [{ source: hiddenVerifier, destination: "test/hidden.txt" }],
      },
    };
    await expect(reverify({
      originalResultPath: evaluation.resultPath,
      task: currentTask,
      taskManifestPath,
      repository,
      allowUnsandboxedVerifier: false,
    })).rejects.toThrow(/not sandboxed/);

    const reverification = await reverify({
      originalResultPath: evaluation.resultPath,
      task: currentTask,
      taskManifestPath,
      repository,
      allowUnsandboxedVerifier: true,
    });

    expect(reverification.result.passed).toBe(true);
    expect(existsSync(reverification.resultPath)).toBe(true);
    expect(readFileSync(evaluation.resultPath, "utf8")).toBe(originalText);
    expect(gitWorktreeCount(repositoryPath)).toBe(1);

    const verified = await loadVerifiedReverification(reverification.resultPath);
    const original = JSON.parse(originalText) as EvaluationResult;
    const summary: SuiteRunSummary = {
      version: 1,
      suiteId: "fixture-suite",
      split: "diagnosis",
      profileId: "baseline",
      model: "test/model",
      startedAt: original.startedAt,
      finishedAt: original.finishedAt,
      passed: false,
      passedTasks: 0,
      totalTasks: 1,
      trials: 1,
      totalCost: 0,
      tasks: [{ taskId: original.taskId, trial: 1, passed: false, resultPath: evaluation.resultPath }],
    };
    const applied = applyReverificationOverrides(
      summary,
      new Map([[evaluation.resultPath, original]]),
      [verified],
    );
    expect(applied.summary).toMatchObject({ passed: true, passedTasks: 1 });
    expect(applied.resultsByPath.get(evaluation.resultPath)?.passed).toBe(true);
    expect(applied.evidence).toEqual([
      expect.objectContaining({ taskId: "fixture-task", originalPassed: false, passed: true }),
    ]);

    writeFileSync(evaluation.resultPath, `${originalText}\n`);
    await expect(loadVerifiedReverification(reverification.resultPath)).rejects.toThrow(/Original result changed/);
  });
});

function gitWorktreeCount(repositoryPath: string): number {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repositoryPath, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}
