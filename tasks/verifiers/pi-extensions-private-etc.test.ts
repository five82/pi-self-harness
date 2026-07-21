import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateDeterministicPolicy } from "../extensions/auto-permissions/policy";

describe("macOS system path aliases", () => {
  it("classifies a direct write under /private/etc", async () => {
    await expect(
      evaluateDeterministicPolicy(
        "write",
        { path: "/private/etc/hosts", content: "replacement" },
        {
          cwd: "/tmp/project",
          repoRoot: "/tmp/project",
          projectTrusted: true,
          agentDir: path.join("/tmp", "agent"),
        },
      ),
    ).resolves.toMatchObject({ action: "classify" });
  });
});
