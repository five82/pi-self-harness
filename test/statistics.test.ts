import { describe, expect, it } from "vitest";
import { bootstrapMeanInterval, pairedFractionChanges } from "../src/statistics.ts";

describe("paired bootstrap statistics", () => {
  it("returns a deterministic interval around the paired mean", () => {
    const first = bootstrapMeanInterval([-0.2, -0.1, 0, 0.1], { samples: 2_000 });
    const second = bootstrapMeanInterval([-0.2, -0.1, 0, 0.1], { samples: 2_000 });

    expect(first).toEqual(second);
    expect(first?.estimate).toBeCloseTo(-0.05);
    expect(first!.lower).toBeLessThan(first!.estimate);
    expect(first!.upper).toBeGreaterThan(first!.estimate);
  });

  it("calculates per-pair fractional changes and skips missing metrics", () => {
    expect(pairedFractionChanges([10, 20, undefined, 0], [8, 30, 1, 1])).toEqual([-0.2, 0.5]);
  });
});
