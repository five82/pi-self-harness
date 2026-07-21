import { describe, expect, it } from "vitest";
import { buildContainerRunArgs } from "../src/container.ts";

describe("container executor", () => {
  it("starts with no capabilities, an isolated workspace, and no network", () => {
    const args = buildContainerRunArgs({
      runtime: "podman",
      image: "node:22-bookworm",
      name: "test-container",
      worktree: "/tmp/worktree",
      cacheDirectory: "/tmp/cache",
      network: "none",
    });

    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--userns=keep-id");
    expect(args).toContain("/tmp/worktree:/workspace:rw");
    expect(args).toContain("none");
    expect(args).toContain("node:22-bookworm");
  });

  it("uses the host uid for Docker", () => {
    const args = buildContainerRunArgs({
      runtime: "docker",
      image: "node:22-bookworm",
      name: "test-container",
      worktree: "/tmp/worktree",
      cacheDirectory: "/tmp/cache",
      network: "bridge",
    });
    expect(args).toContain("--user");
    expect(args).not.toContain("--userns=keep-id");
  });
});
