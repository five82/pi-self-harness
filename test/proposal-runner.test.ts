import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProposalModel } from "../src/proposal-runner.ts";

describe("proposal model runner", () => {
  it("captures an ephemeral tool-free proposal trace", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-self-harness-proposal-runner-"));
    const command = join(root, "fake-pi");
    const message = {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "fake",
        model: "proposal",
        stopReason: "stop",
        usage: { cost: { total: 0 } },
        content: [{ type: "text", text: '{"id":"candidate"}' }],
      },
    };
    writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(message)}'\n`);
    chmodSync(command, 0o755);

    const run = await runProposalModel({
      root,
      runsDirectory: join(root, "runs"),
      artifactId: "candidate",
      model: "fake/proposal",
      prompt: "evidence",
      piCommand: command,
      timeoutSeconds: 10,
    });

    expect(run.process.code).toBe(0);
    expect(run.trace.finalText).toBe('{"id":"candidate"}');
    expect(run.tracePath).toContain("/proposals/candidate/");
  });
});
