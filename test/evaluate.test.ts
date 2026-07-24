import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/runner.ts";
import type { HarnessProfile, RepositoryDefinition, TaskDefinition } from "../src/types.ts";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("evaluate", () => {
  it("runs a mocked agent in a detached worktree and records verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-self-harness-evaluate-"));
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
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.0.0; exit 0; fi\necho '{\"type\":\"agent_end\"}'\nprintf 'done\\n' > done.txt\ngit rev-list --count HEAD > history-count.txt\n",
    );
    chmodSync(fakePi, 0o755);

    const hiddenVerifier = join(root, "hidden.txt");
    writeFileSync(hiddenVerifier, "hidden\n");
    const repository: RepositoryDefinition = {
      id: "fixture",
      path: repositoryPath,
    };
    const task: TaskDefinition = {
      version: 1,
      id: "fixture-task",
      repository: "fixture",
      summary: "Fixture task",
      prompt: "Create done.txt",
      baseRevision: "HEAD",
      verification: {
        command: "test -f done.txt && test -f test/hidden.txt && test \"$(cat history-count.txt)\" = 1",
        inject: [{ source: hiddenVerifier, destination: "test/hidden.txt" }],
      },
    };
    const profile: HarnessProfile = { version: 1, id: "baseline" };

    const { result, resultPath } = await evaluate({
      task,
      repository,
      profile,
      model: "test/model",
      piCommand: fakePi,
      runsDirectory: join(root, "runs"),
      allowUnsandboxedAgent: true,
    });

    expect(result.passed).toBe(true);
    expect(result.agent?.code).toBe(0);
    expect(result.piVersion).toBe("1.0.0");
    expect(result.verification?.code).toBe(0);
    expect(result.injectedVerificationAssets).toEqual(["test/hidden.txt"]);
    expect(existsSync(resultPath)).toBe(true);
    expect(JSON.parse(readFileSync(resultPath, "utf8")).passed).toBe(true);
    expect(readFileSync(join(root, "runs", "fixture-task", result.runId, "agent.patch"), "utf8")).toContain("done.txt");
    expect(gitWorktreeCount(repositoryPath)).toBe(1);
  });
});

function gitWorktreeCount(repositoryPath: string): number {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repositoryPath, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}
