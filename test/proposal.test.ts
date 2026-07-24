import { describe, expect, it } from "vitest";
import type { WeaknessEvidence } from "../src/mining.ts";
import {
  buildProposalPiArgs,
  buildProposalPrompt,
  formatProfile,
  parseProposalHistory,
  parseProposedProfile,
} from "../src/proposal.ts";

const evidence: WeaknessEvidence = {
  version: 1,
  suiteId: "personal",
  split: "diagnosis",
  profileId: "baseline",
  model: "provider/target",
  trials: 1,
  attempts: 1,
  passedAttempts: 1,
  totalCost: 0.2,
  totalDurationMs: 1_000,
  totalToolCalls: 4,
  totalToolErrors: 1,
  tasks: [{ taskId: "task-one", trial: 1, passed: true, finalText: "A check failed once." }],
};

describe("bounded profile proposals", () => {
  it("runs the proposer without tools, resources, context, or trust", () => {
    const args = buildProposalPiArgs({ model: "provider/model", thinking: "high", prompt: "evidence" });
    expect(args).toEqual(expect.arrayContaining([
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--no-approve",
    ]));
    expect(args.at(-1)).toBe("evidence");
  });

  it("parses a fenced declarative instruction proposal", () => {
    const profile = parseProposedProfile(
      '```json\n{"id":"candidate-one","description":"Test retry behavior","systemPromptAppend":"After a command fails, inspect its error before choosing a different check."}\n```',
      "candidate-one",
      evidence,
    );

    expect(profile).toMatchObject({ version: 1, id: "candidate-one" });
    expect(formatProfile(profile)).toContain("systemPromptAppend: After a command fails");
  });

  it("allows only container-routed tool names", () => {
    expect(() =>
      parseProposedProfile(
        '{"id":"candidate","description":"Add search","tools":["read","grep"]}',
        "candidate",
        evidence,
      ),
    ).toThrow(/unsupported tool.*grep/);
  });

  it("rejects executable fields and diagnosis-task references", () => {
    expect(() =>
      parseProposedProfile(
        '{"id":"candidate","description":"Unsafe","extensions":["x.ts"]}',
        "candidate",
        evidence,
      ),
    ).toThrow("unsupported field");
    expect(() =>
      parseProposedProfile(
        '{"id":"candidate","description":"Overfit","systemPromptAppend":"Special-case task-one."}',
        "candidate",
        evidence,
      ),
    ).toThrow("mentions diagnosis task");
  });

  it("includes structured rejected hypotheses in the proposal prompt", () => {
    const history = parseProposalHistory(`version: 1
rejections:
  - id: rejected
    hypothesis: Add more retries
    reason: Increased cost
`);
    const prompt = buildProposalPrompt(evidence, "candidate-one", history);
    expect(prompt).toContain('"id":"candidate-one"');
    expect(prompt).toContain('"taskId": "task-one"');
    expect(prompt).toContain("Add more retries");
  });
});
