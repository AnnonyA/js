import type { ResolvedDecompileOptions } from "../types.js";

export function acceptsCleanConfidence(
  confidence: number,
  options: ResolvedDecompileOptions,
): boolean {
  return Number.isFinite(confidence) && confidence >= options.confidence.cleanThreshold;
}
