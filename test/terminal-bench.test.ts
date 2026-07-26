import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareTerminalBenchJobs, loadTerminalBenchJob } from "../src/terminal-bench.ts";

async function makeJob(
  root: string,
  name: string,
  rewards: Record<string, number>,
  profileSha256: string,
  costs: Record<string, number> = {},
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory);
  const tasks = Object.entries(rewards);
  await writeFile(join(directory, "result.json"), JSON.stringify({
    n_total_trials: tasks.length,
    stats: { n_completed_trials: tasks.length, n_errored_trials: 0 },
  }));
  for (const [index, [taskName, reward]] of tasks.entries()) {
    const trialDirectory = join(directory, `trial-${index}`);
    await mkdir(trialDirectory);
    await writeFile(join(trialDirectory, "result.json"), JSON.stringify({
      task_name: `terminal-bench/${taskName}`,
      task_checksum: `checksum-${taskName}`,
      agent_info: {
        name: "pi-host",
        version: "0.82.0",
        model_info: { provider: "openai-codex", name: "gpt-test" },
      },
      agent_result: {
        cost_usd: costs[taskName] ?? 1,
        metadata: {
          pi_version: "0.82.0",
          extension_sha256: "extension-sha",
          benchmark_provenance_sha256: "provenance-sha",
          benchmark_source_revision: "source-revision",
          terminal_stop_reason: "stop",
          thinking: "high",
          profile_sha256: profileSha256,
        },
      },
      verifier_result: { rewards: { reward } },
      exception_info: null,
      agent_execution: {
        started_at: "2026-01-01T00:00:00Z",
        finished_at: `2026-01-01T00:00:0${index + 1}Z`,
      },
    }));
  }
  return directory;
}

describe("Terminal-Bench Harbor comparison", () => {
  it("loads complete jobs and accepts equal per-task rewards within the cost gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-bench-test-"));
    try {
      const baselinePath = await makeJob(root, "baseline", { one: 1, two: 0 }, "baseline", { one: 2, two: 2 });
      const candidatePath = await makeJob(root, "candidate", { one: 1, two: 0 }, "candidate", { one: 2.1, two: 2.1 });
      const baseline = await loadTerminalBenchJob(baselinePath);
      const candidate = await loadTerminalBenchJob(join(candidatePath, "result.json"));
      const report = compareTerminalBenchJobs(baseline, candidate, 0.1);
      expect(report.passed).toBe(true);
      expect(report.tasks).toHaveLength(2);
      expect(report.costDeltaFraction).toBeCloseTo(0.05);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects any per-task reward regression and excessive aggregate cost", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-bench-test-"));
    try {
      const baseline = await loadTerminalBenchJob(await makeJob(root, "baseline", { one: 1 }, "baseline", { one: 1 }));
      const candidate = await loadTerminalBenchJob(await makeJob(root, "candidate", { one: 0 }, "candidate", { one: 2 }));
      const report = compareTerminalBenchJobs(baseline, candidate);
      expect(report.passed).toBe(false);
      expect(report.reasons).toEqual([
        "terminal-bench/one: reward regressed",
        "aggregate cost exceeded regression limit",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete Harbor jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-bench-test-"));
    try {
      const job = await makeJob(root, "incomplete", { one: 1 }, "baseline");
      await writeFile(join(job, "result.json"), JSON.stringify({
        n_total_trials: 1,
        stats: { n_completed_trials: 0, n_errored_trials: 0 },
      }));
      await expect(loadTerminalBenchJob(job)).rejects.toThrow("Harbor job is incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
