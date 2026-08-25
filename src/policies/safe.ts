import type { ResolvedDecompileOptions } from "../types.js";

export function acceptsSafeConfidence(
  confidence: number,
  options: ResolvedDecompileOptions,
): boolean {
  return Number.isFinite(confidence) && confidence >= options.confidence.safeThreshold;
}
