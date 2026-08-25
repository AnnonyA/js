import type { DecompilerContext } from "../../core/context.js";
import { walk } from "./ast.js";
import { detectStringConcealing as detectStructuralStringConcealing } from "./structural.js";
import { detection, type DetectionResult } from "./types.js";

export function detectStringConcealing(ctx: DecompilerContext): DetectionResult {
  const structural = detectStructuralStringConcealing(ctx);
  let textDecoderAlias = false;
  let byteRuntimeAlias = false;

  walk(ctx.inputAst, (node) => {
    if (node.type === "StringLiteral" && node.value === "TextDecoder") {
      textDecoderAlias = true;
    }
    if (
      node.type === "StringLiteral" &&
      (node.value === "Uint8Array" || node.value === "Buffer")
    ) {
      byteRuntimeAlias = true;
    }
  });

  if (
    structural.confidence >= 0.6 &&
    textDecoderAlias &&
    byteRuntimeAlias
  ) {
    return detection(0.98, [
      ...structural.evidence,
      "aliased TextDecoder/byte runtime",
    ]);
  }

  return structural;
}
