import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SuiteRunSummary } from "./suite.ts";
import type { EvaluationResult, ReverificationResult } from "./types.ts";

export interface ReverificationEvidence {
  reverificationId: string;
  taskId: string;
  trial: number;
  originalPassed: boolean;
  passed: boolean;
  originalResultSha256: string;
  agentPatchSha256: string;
  verifierSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseReverification(value: string, path: string): ReverificationResult {
  const parsed = JSON.parse(value) as Partial<ReverificationResult>;
  if (
    parsed.version !== 1 ||
    typeof parsed.reverificationId !== "string" ||
    typeof parsed.originalResultPath !== "string" ||
    typeof parsed.originalResultSha256 !== "string" ||
    typeof parsed.agentPatchPath !== "string" ||
    typeof parsed.agentPatchSha256 !== "string" ||
    typeof parsed.verifierSha256 !== "string" ||
    typeof parsed.taskId !== "string" ||
    typeof parsed.repositoryId !== "string" ||
    typeof parsed.sourceRevision !== "string" ||
    typeof parsed.passed !== "boolean" ||
    !parsed.verification
  ) {
    throw new Error(`Invalid completed reverification artifact: ${path}`);
  }
  const processPassed = parsed.verification.code === 0 && !parsed.verification.timedOut;
  if (processPassed !== parsed.passed || (!parsed.passed && parsed.failureStage !== "verification")) {
    throw new Error(`Inconsistent reverification verdict: ${path}`);
  }
  return parsed as ReverificationResult;
}

export async function loadVerifiedReverification(path: string): Promise<ReverificationResult> {
  const artifactPath = resolve(path);
  const reverification = parseReverification(await readFile(artifactPath, "utf8"), artifactPath);
  const originalResultPath = resolve(reverification.originalResultPath);
  const expectedPatchPath = join(dirname(originalResultPath), "agent.patch");
  if (resolve(reverification.agentPatchPath) !== expectedPatchPath) {
    throw new Error(`Reverification patch is not the captured patch beside its original result: ${artifactPath}`);
  }

  const originalText = await readFile(originalResultPath, "utf8");
  const patch = await readFile(expectedPatchPath);
  if (sha256(originalText) !== reverification.originalResultSha256) {
    throw new Error(`Original result changed after reverification: ${originalResultPath}`);
  }
  if (sha256(patch) !== reverification.agentPatchSha256) {
    throw new Error(`Captured patch changed after reverification: ${expectedPatchPath}`);
  }

  const original = JSON.parse(originalText) as EvaluationResult;
  if (
    original.version !== 1 ||
    original.taskId !== reverification.taskId ||
    original.repositoryId !== reverification.repositoryId ||
    original.sourceRevision !== reverification.sourceRevision
  ) {
    throw new Error(`Reverification does not match original result metadata: ${artifactPath}`);
  }
  return reverification;
}

export function applyReverificationOverrides(
  summary: SuiteRunSummary,
  resultsByPath: ReadonlyMap<string, EvaluationResult>,
  reverifications: readonly ReverificationResult[],
): {
  summary: SuiteRunSummary;
  resultsByPath: Map<string, EvaluationResult>;
  evidence: ReverificationEvidence[];
} {
  const byResultPath = new Map<string, ReverificationResult>();
  for (const reverification of reverifications) {
    const resultPath = resolve(reverification.originalResultPath);
    if (byResultPath.has(resultPath)) throw new Error(`Multiple reverifications supplied for ${resultPath}`);
    byResultPath.set(resultPath, reverification);
  }

  const results = new Map(resultsByPath);
  const evidence: ReverificationEvidence[] = [];
  const tasks = summary.tasks.map((task) => {
    if (!task.resultPath) return task;
    const resultPath = resolve(task.resultPath);
    const reverification = byResultPath.get(resultPath);
    if (!reverification) return task;
    const original = resultsByPath.get(task.resultPath) ?? resultsByPath.get(resultPath);
    if (!original) throw new Error(`Missing original result for reverification: ${resultPath}`);
    if (original.taskId !== task.taskId || reverification.taskId !== task.taskId) {
      throw new Error(`Reverification task does not match suite entry ${task.taskId}`);
    }
    const revised: EvaluationResult = {
      ...original,
      passed: reverification.passed,
      failureStage: reverification.passed ? undefined : "verification",
      verification: reverification.verification,
      error: reverification.passed ? undefined : original.error,
    };
    results.set(task.resultPath, revised);
    if (task.resultPath !== resultPath) results.set(resultPath, revised);
    evidence.push({
      reverificationId: reverification.reverificationId,
      taskId: task.taskId,
      trial: task.trial ?? 1,
      originalPassed: task.passed,
      passed: reverification.passed,
      originalResultSha256: reverification.originalResultSha256,
      agentPatchSha256: reverification.agentPatchSha256,
      verifierSha256: reverification.verifierSha256,
    });
    return { ...task, passed: reverification.passed, error: reverification.passed ? undefined : task.error };
  });

  for (const resultPath of byResultPath.keys()) {
    if (!summary.tasks.some((task) => task.resultPath && resolve(task.resultPath) === resultPath)) {
      throw new Error(`Reverification result is not present in suite summary: ${resultPath}`);
    }
  }

  const passedTasks = tasks.filter((task) => task.passed).length;
  return {
    summary: { ...summary, tasks, passed: passedTasks === tasks.length, passedTasks },
    resultsByPath: results,
    evidence,
  };
}
