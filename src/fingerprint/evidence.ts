import type { FingerprintEvidence } from "./types.js";

export function makeEvidence(
  id: string,
  weight: number,
  matched: boolean,
  detail: string,
): FingerprintEvidence {
  return { id, weight, matched, detail };
}

export function scoreEvidence(
  evidence: readonly FingerprintEvidence[],
  bias = -2.6,
): number {
  const raw = evidence.reduce(
    (score, item) => score + (item.matched ? item.weight : 0),
    bias,
  );
  return 1 / (1 + Math.exp(-raw));
}

export function normalizeCandidateWeights(
  weights: Record<string, number>,
): Record<string, number> {
  const positive = Object.entries(weights).filter(([, weight]) => weight > 0);
  const total = positive.reduce((sum, [, weight]) => sum + weight, 0);
  if (total === 0) return {};

  return Object.fromEntries(
    positive.map(([version, weight]) => [version, weight / total]),
  );
}
