import type { DecompilerContext } from "../../core/context.js";
import { findStringSplittingCandidates } from "../../passes/jsconfuser/strings/splitting213.js";
import { detection, type DetectionResult } from "./types.js";

export function detectStringSplitting(ctx: DecompilerContext): DetectionResult {
  const candidates = findStringSplittingCandidates(ctx.inputAst);
  if (candidates.length === 0) return detection(0);

  return detection(0.99, [
    `${candidates.length} js-confuser-style literal concatenation chains`,
    "left-deep string additions include the generated empty-string sentinel",
  ]);
}
