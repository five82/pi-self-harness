import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCommandAllowed, buildPiArgs, removeTemporaryRoot } from "../src/runner.ts";
import type { HarnessProfile, RepositoryDefinition, TaskDefinition } from "../src/types.ts";

const task: TaskDefinition = {
  version: 1,
  id: "example",
  repository: "sample",
  summary: "Example",
  prompt: "Fix the bug.",
  baseRevision: "abc123",
};

const profile: HarnessProfile = {
  version: 1,
  id: "candidate",
  systemPromptAppend: "Verify before finishing.",
  tools: ["read", "bash", "edit", "write"],
};

describe("runner", () => {
  it("builds an explicit, ephemeral Pi invocation", () => {
    const args = buildPiArgs({
      task,
      profile,
      model: "provider/model",
      thinking: "high",
      requiredExtensions: ["/tmp/container-tools.ts"],
    });
    expect(args).toContain("--no-session");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-approve");
    expect(args).toContain("provider/model");
    expect(args).toContain("Verify before finishing.");
    expect(args).toContain("/tmp/container-tools.ts");
    expect(args.at(-1)).toBe("Fix the bug.");
  });

  it("removes read-only tool caches", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-self-harness-cache-test-"));
    const cache = join(root, "module");
    mkdirSync(cache);
    writeFileSync(join(cache, "source.go"), "package fixture\n");
    chmodSync(cache, 0o555);

    await removeTemporaryRoot(root);

    expect(existsSync(root)).toBe(false);
  });

  it("rejects configured dangerous setup or verifier commands", () => {
    const repository: RepositoryDefinition = {
      id: "infra",
      path: "/tmp/infra",
      safety: { forbiddenCommands: ["systemctl", "pyinfra @"] },
    };
    expect(() => assertCommandAllowed("systemctl restart service", repository)).toThrow(/forbidden/);
    expect(() => assertCommandAllowed("uv run pytest", repository)).not.toThrow();
  });
});
