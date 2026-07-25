import type { ReverificationEvidence } from "./reverification.ts";
import type { SuiteRunSummary } from "./suite.ts";
import type { EvaluationResult, TraceSummary } from "./types.ts";

const MAX_FINAL_TEXT = 2_000;
const MAX_ERROR_TEXT = 1_000;
const MAX_TOOL_ERROR_TEXT = 600;
const MAX_TOOL_ERRORS_PER_ATTEMPT = 5;

export interface ToolErrorEvidence {
  tool: string;
  message: string;
}

export interface WeaknessAttempt {
  taskId: string;
  trial: number;
  passed: boolean;
  durationMs?: number;
  cost?: number;
  toolCalls?: number;
  toolErrors?: number;
  toolsByName?: Record<string, number>;
  toolErrorsByName?: Record<string, number>;
  toolErrorDetails?: ToolErrorEvidence[];
  stopReason?: string;
  finalText?: string;
  failureStage?: EvaluationResult["failureStage"];
  error?: string;
}

export interface WeaknessEvidence {
  version: 1;
  suiteId: string;
  split: "diagnosis";
  profileId: string;
  model: string;
  thinking?: string;
  trials: number;
  attempts: number;
  passedAttempts: number;
  totalCost: number;
  totalDurationMs: number;
  totalToolCalls: number;
  totalToolErrors: number;
  reverifications?: ReverificationEvidence[];
  tasks: WeaknessAttempt[];
}

function truncate(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[^\t\n\r\x20-\x7E]/g, "");
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum)}...`;
}

export function extractToolErrorEvidence(jsonl: string): ToolErrorEvidence[] {
  const errors: ToolErrorEvidence[] = [];
  for (const line of jsonl.split("\n")) {
    if (errors.length >= MAX_TOOL_ERRORS_PER_ATTEMPT) break;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "tool_execution_end" || !event.isError) continue;
    const content = event.result?.content;
    const message = Array.isArray(content)
      ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
      : typeof event.result === "string"
        ? event.result
        : typeof event.result?.error === "string"
          ? event.result.error
          : "Tool call failed without text output";
    errors.push({
      tool: String(event.toolName ?? "unknown"),
      message: truncate(String(message), MAX_TOOL_ERROR_TEXT) ?? "Tool call failed without text output",
    });
  }
  return errors;
}

function traceFields(trace: TraceSummary | undefined): Pick<
  WeaknessAttempt,
  "cost" | "toolCalls" | "toolErrors" | "toolsByName" | "toolErrorsByName" | "stopReason" | "finalText"
> {
  return {
    cost: trace?.usage.cost,
    toolCalls: trace?.toolCalls,
    toolErrors: trace?.toolErrors,
    toolsByName: trace?.toolsByName,
    toolErrorsByName: trace?.toolErrorsByName,
    stopReason: trace?.finalStopReason,
    finalText: truncate(trace?.finalText, MAX_FINAL_TEXT),
  };
}

export function buildWeaknessEvidence(
  summary: SuiteRunSummary,
  resultsByPath: ReadonlyMap<string, EvaluationResult>,
  toolErrorsByResultPath: ReadonlyMap<string, ToolErrorEvidence[]> = new Map(),
  reverifications: ReverificationEvidence[] = [],
): WeaknessEvidence {
  if (summary.split !== "diagnosis") throw new Error("Weakness mining only accepts diagnosis summaries");

  const tasks = summary.tasks.map((task): WeaknessAttempt => {
    const result = task.resultPath ? resultsByPath.get(task.resultPath) : undefined;
    if (task.resultPath && !result) throw new Error(`Missing result for ${task.resultPath}`);
    if (
      result &&
      (result.taskId !== task.taskId ||
        result.profileId !== summary.profileId ||
        result.model !== summary.model ||
        result.passed !== task.passed)
    ) {
      throw new Error(`Result metadata does not match suite summary for ${task.taskId}`);
    }
    return {
      taskId: task.taskId,
      trial: task.trial ?? 1,
      passed: task.passed,
      durationMs: result ? Date.parse(result.finishedAt) - Date.parse(result.startedAt) : task.durationMs,
      ...traceFields(result?.trace),
      toolErrorDetails: task.resultPath ? toolErrorsByResultPath.get(task.resultPath) : undefined,
      failureStage: result?.failureStage,
      error: truncate(result?.error ?? task.error, MAX_ERROR_TEXT),
    };
  });

  return {
    version: 1,
    suiteId: summary.suiteId,
    split: "diagnosis",
    profileId: summary.profileId,
    model: summary.model,
    thinking: summary.thinking,
    trials: new Set(tasks.map((task) => task.trial)).size,
    attempts: tasks.length,
    passedAttempts: tasks.filter((task) => task.passed).length,
    totalCost: tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0),
    totalDurationMs: tasks.reduce((sum, task) => sum + (task.durationMs ?? 0), 0),
    totalToolCalls: tasks.reduce((sum, task) => sum + (task.toolCalls ?? 0), 0),
    totalToolErrors: tasks.reduce((sum, task) => sum + (task.toolErrors ?? 0), 0),
    reverifications: reverifications.length ? reverifications : undefined,
    tasks,
  };
}
