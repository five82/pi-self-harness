import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeTrace } from "../src/trace.ts";

describe("trace summary", () => {
  it("aggregates tool behavior, usage, and final text", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-self-harness-trace-")), "agent.jsonl");
    const events = [
      { type: "turn_end" },
      { type: "tool_execution_start", toolName: "bash" },
      { type: "tool_execution_end", toolName: "bash", isError: true },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite: 1,
            reasoning: 3,
            cost: { total: 0.25 },
          },
          content: [{ type: "text", text: "Done" }],
        },
      },
    ];
    writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    await expect(summarizeTrace(path)).resolves.toMatchObject({
      turns: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolErrors: 1,
      toolsByName: { bash: 1 },
      toolErrorsByName: { bash: 1 },
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: 3, cost: 0.25 },
      finalStopReason: "stop",
      finalText: "Done",
    });
  });
});
