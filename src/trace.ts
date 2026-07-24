import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { TraceSummary } from "./types.ts";

const MAX_FINAL_TEXT = 8_000;

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function emptySummary(): TraceSummary {
  return {
    turns: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolsByName: {},
    toolErrorsByName: {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
  };
}

function addLine(summary: TraceSummary, line: string): void {
  if (!line.trim()) return;
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (event.type === "turn_end") summary.turns++;
  if (event.type === "tool_execution_start") {
    summary.toolCalls++;
    increment(summary.toolsByName, String(event.toolName ?? "unknown"));
  }
  if (event.type === "tool_execution_end" && event.isError) {
    summary.toolErrors++;
    increment(summary.toolErrorsByName, String(event.toolName ?? "unknown"));
  }
  if (event.type !== "message_end" || event.message?.role !== "assistant") return;

  summary.assistantMessages++;
  summary.provider = event.message.provider ?? summary.provider;
  summary.model = event.message.model ?? summary.model;
  const usage = event.message.usage ?? {};
  summary.usage.input += usage.input ?? 0;
  summary.usage.output += usage.output ?? 0;
  summary.usage.cacheRead += usage.cacheRead ?? 0;
  summary.usage.cacheWrite += usage.cacheWrite ?? 0;
  summary.usage.reasoning += usage.reasoning ?? 0;
  summary.usage.cost += usage.cost?.total ?? 0;
  summary.finalStopReason = event.message.stopReason;

  const text = (event.message.content ?? [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
  if (text) summary.finalText = text.length <= MAX_FINAL_TEXT ? text : text.slice(-MAX_FINAL_TEXT);
}

export function summarizeTraceText(text: string): TraceSummary {
  const summary = emptySummary();
  for (const line of text.split("\n")) addLine(summary, line);
  return summary;
}

export async function summarizeTrace(path: string): Promise<TraceSummary> {
  const summary = emptySummary();
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) addLine(summary, line);
  return summary;
}
