import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProposalPiArgs } from "./proposal.ts";
import { runProcess } from "./process.ts";
import { summarizeTrace } from "./trace.ts";
import type { ProcessResult, TraceSummary } from "./types.ts";

export interface ProposalModelRun {
  runId: string;
  runDirectory: string;
  startedAt: string;
  finishedAt: string;
  tracePath: string;
  stderrPath: string;
  process: ProcessResult;
  trace: TraceSummary;
}

export async function runProposalModel(options: {
  root: string;
  runsDirectory: string;
  artifactId: string;
  model: string;
  thinking?: string;
  prompt: string;
  piCommand?: string;
  timeoutSeconds: number;
}): Promise<ProposalModelRun> {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}_${options.artifactId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  const runDirectory = resolve(options.runsDirectory, "proposals", options.artifactId, runId);
  await mkdir(runDirectory, { recursive: true });
  const tracePath = join(runDirectory, "proposal.jsonl");
  const stderrPath = join(runDirectory, "proposal.stderr.log");
  const processResult = await runProcess({
    command: options.piCommand ?? "pi",
    args: buildProposalPiArgs({ model: options.model, thinking: options.thinking, prompt: options.prompt }),
    cwd: options.root,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    timeoutMs: options.timeoutSeconds * 1_000,
    stdoutPath: tracePath,
    stderrPath,
  });
  return {
    runId,
    runDirectory,
    startedAt,
    finishedAt: new Date().toISOString(),
    tracePath,
    stderrPath,
    process: processResult,
    trace: await summarizeTrace(tracePath),
  };
}
