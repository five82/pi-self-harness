export interface ConfidenceInterval {
  estimate: number;
  lower: number;
  upper: number;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sorted: number[], probability: number): number {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function bootstrapMeanInterval(
  values: number[],
  options: { samples?: number; confidence?: number; seed?: number } = {},
): ConfidenceInterval | undefined {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return undefined;
  const samples = options.samples ?? 10_000;
  const confidence = options.confidence ?? 0.95;
  if (!Number.isInteger(samples) || samples < 100) throw new Error("Bootstrap samples must be an integer of at least 100");
  if (!(confidence > 0 && confidence < 1)) throw new Error("Bootstrap confidence must be between zero and one");

  const next = random(options.seed ?? 0x582);
  const means = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) {
      total += values[Math.floor(next() * values.length)];
    }
    means[sample] = total / values.length;
  }
  means.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    estimate: mean(values),
    lower: quantile(means, tail),
    upper: quantile(means, 1 - tail),
  };
}

export function pairedFractionChanges(baseline: Array<number | undefined>, candidate: Array<number | undefined>): number[] {
  if (baseline.length !== candidate.length) throw new Error("Paired metric arrays must have equal length");
  const changes: number[] = [];
  for (let index = 0; index < baseline.length; index++) {
    const before = baseline[index];
    const after = candidate[index];
    if (before === undefined || after === undefined || before <= 0) continue;
    changes.push((after - before) / before);
  }
  return changes;
}
