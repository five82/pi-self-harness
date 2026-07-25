import type { EvaluationResult, ProcessResult } from "./types.ts";

const RUNTIME_CONNECTION_ERROR = /(?:error during connect|failed to connect to the (?:docker|podman) api|cannot connect to the .*daemon|dial unix .*connect:|connection refused)/i;

function runtimeProcessFailure(process: ProcessResult | undefined): string | undefined {
  if (!process || !["docker", "podman"].includes(process.command) || process.code === 0) return undefined;
  const output = `${process.stderrTail}\n${process.stdoutTail}`;
  return RUNTIME_CONNECTION_ERROR.test(output) ? output.trim() : undefined;
}

export function evaluatorInfrastructureFailure(result: EvaluationResult): string | undefined {
  if (result.failureStage === "executor") return result.error ?? "Evaluator executor failed";
  if (result.containerCleanupError) return result.containerCleanupError;
  for (const process of [result.setup, result.verification]) {
    const failure = runtimeProcessFailure(process);
    if (failure) return failure;
  }
  if (result.cleanupError && /container .* could not be stopped/i.test(result.cleanupError)) return result.cleanupError;
  return undefined;
}
