import type { DecompilerContext } from "../../core/context.js";

export interface DetectionResult {
  confidence: number;
  evidence: string[];
}

export type TransformDetector = (ctx: DecompilerContext) => DetectionResult;

export function detection(
  confidence: number,
  evidence: string[] = [],
): DetectionResult {
  return {
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence,
  };
}
