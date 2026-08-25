import { normalizeCandidateWeights } from "./evidence.js";
import type { FingerprintEvidence } from "./types.js";

function matched(evidence: readonly FingerprintEvidence[], id: string): boolean {
  return evidence.some((item) => item.id === id && item.matched);
}

export function rankVersionCandidates(
  evidence: readonly FingerprintEvidence[],
  confidence: number,
): Record<string, number> {
  if (confidence < 0.5) return {};

  const stateArray =
    matched(evidence, "cff.largeNumericStateArray") ||
    matched(evidence, "cff.signedNumericStateArray");
  const stateXor = matched(evidence, "cff.stateStringXorHelper");
  const dynamicTransitions = matched(
    evidence,
    "cff.crossIndexedStateMutation",
  );
  const recursiveDispatcher = matched(evidence, "cff.recursiveDispatcher");

  if (stateArray && stateXor && dynamicTransitions && recursiveDispatcher) {
    return normalizeCandidateWeights({
      "2.1.3": 5,
      "2.1.2": 2,
      "2.1.x": 0.5,
    });
  }

  if (stateArray && stateXor) {
    return normalizeCandidateWeights({
      "2.1.2": 4,
      "2.1.3": 1.5,
      "2.1.x": 0.5,
    });
  }

  return normalizeCandidateWeights({ "2.1.x": 1 });
}

export function selectFamily(
  confidence: number,
  candidates: Record<string, number>,
): string | null {
  if (confidence < 0.5) return null;
  if ((candidates["2.1.3"] ?? 0) >= 0.6) return "babel-2.1.3";
  if ((candidates["2.1.2"] ?? 0) > 0) return "babel-2.1.2+";
  return "babel-2.1";
}
