import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandPath, loadProfile, loadRepositoryConfig, loadSuite, loadTask } from "../src/config.ts";

function fixture(name: string, content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-self-harness-test-"));
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

describe("configuration", () => {
  it("loads repository inventory and expands home paths", () => {
    const path = fixture(
      "repositories.yaml",
      `version: 1
repositories:
  - id: sample
    path: ~/projects/sample
    defaultVerification:
      command: npm test
`,
    );
    const config = loadRepositoryConfig(path);
    expect(config.repositories[0].path).toBe(expandPath("~/projects/sample"));
    expect(config.repositories[0].defaultVerification?.command).toBe("npm test");
  });

  it("rejects duplicate repository ids", () => {
    const path = fixture(
      "repositories.yaml",
      `version: 1
repositories:
  - { id: sample, path: /tmp/a }
  - { id: sample, path: /tmp/b }
`,
    );
    expect(() => loadRepositoryConfig(path)).toThrow(/duplicate repository id/);
  });

  it("loads task and profile manifests", () => {
    const taskPath = fixture(
      "task.yaml",
      `version: 1
id: fix-one
repository: sample
summary: Fix one thing
prompt: Fix the failing behavior.
baseRevision: abc123
verification:
  command: npm test
`,
    );
    const profilePath = fixture(
      "profile.yaml",
      `version: 1
id: retry-nudge
systemPromptAppend: Change strategy after repeated failures.
tools: [read, bash, edit, write]
`,
    );
    expect(loadTask(taskPath).baseRevision).toBe("abc123");
    expect(loadProfile(profilePath).tools).toEqual(["read", "bash", "edit", "write"]);
  });

  it("rejects executable and unknown profile fields", () => {
    const path = fixture(
      "profile.yaml",
      `version: 1
id: unsafe-extension
extensions: [extension.ts]
`,
    );
    expect(() => loadProfile(path)).toThrow(/unsupported candidate profile field/);
  });

  it("rejects profile tools that could bypass container routing", () => {
    const path = fixture(
      "profile.yaml",
      `version: 1
id: unsafe-tools
tools: [read, grep]
`,
    );
    expect(() => loadProfile(path)).toThrow(/unsupported tool.*grep/);
  });

  it("loads a Linux container executor", () => {
    const path = fixture(
      "task.yaml",
      `version: 1
id: container-task
repository: sample
summary: Container task
prompt: Fix the bug
baseRevision: abc123
executor:
  type: container
  os: linux
  runtime: podman
  image: node:22-bookworm
  agentNetwork: none
`,
    );
    expect(loadTask(path).executor).toMatchObject({
      type: "container",
      os: "linux",
      runtime: "podman",
      image: "node:22-bookworm",
      agentNetwork: "none",
    });
  });

  it("rejects a container executor without an image", () => {
    const path = fixture(
      "task.yaml",
      `version: 1
id: container-task
repository: sample
summary: Container task
prompt: Fix the bug
baseRevision: abc123
executor:
  type: container
`,
    );
    expect(() => loadTask(path)).toThrow(/image.*required/);
  });

  it("resolves hidden verifier assets relative to the task manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-self-harness-test-"));
    writeFileSync(join(directory, "hidden.test.ts"), "export {};\n");
    const path = join(directory, "task.yaml");
    writeFileSync(
      path,
      `version: 1
id: hidden-verifier
repository: sample
summary: Hidden verifier
prompt: Fix the bug
baseRevision: abc123
verification:
  command: npm test
  inject:
    - source: hidden.test.ts
      destination: test/hidden.test.ts
`,
    );
    expect(loadTask(path).verification?.inject).toEqual([
      { source: join(directory, "hidden.test.ts"), destination: "test/hidden.test.ts" },
    ]);
  });

  it("rejects verifier destinations outside the worktree", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-self-harness-test-"));
    writeFileSync(join(directory, "hidden.test.ts"), "export {};\n");
    const path = join(directory, "task.yaml");
    writeFileSync(
      path,
      `version: 1
id: bad-verifier
repository: sample
summary: Bad verifier
prompt: Fix the bug
baseRevision: abc123
verification:
  command: npm test
  inject:
    - source: hidden.test.ts
      destination: ../outside.test.ts
`,
    );
    expect(() => loadTask(path)).toThrow(/must stay inside/);
  });

  it("keeps suite splits disjoint", () => {
    const valid = fixture(
      "suite.yaml",
      `version: 1
id: personal
diagnosis: [task-one]
validation: [task-two]
test: [task-three]
`,
    );
    expect(loadSuite(valid).test).toEqual(["task-three"]);

    const duplicate = fixture(
      "suite.yaml",
      `version: 1
id: personal
diagnosis: [task-one]
validation: [task-one]
test: []
`,
    );
    expect(() => loadSuite(duplicate)).toThrow(/multiple splits/);
  });

  it("rejects unsupported schema versions", () => {
    const path = fixture(
      "task.yaml",
      `version: 2
id: bad
repository: sample
summary: Bad task
prompt: Do something
baseRevision: HEAD
`,
    );
    expect(() => loadTask(path)).toThrow(/expected 1/);
  });
});
