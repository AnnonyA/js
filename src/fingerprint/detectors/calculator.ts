import type { DecompilerContext } from "../../core/context.js";
import { findCalculatorModels } from "../../passes/jsconfuser/calculator/model.js";
import { detection, type DetectionResult } from "./types.js";

export function detectCalculator(ctx: DecompilerContext): DetectionResult {
  const models = findCalculatorModels(ctx.inputAst);
  if (models.length === 0) return detection(0);

  const selectorCount = models.reduce(
    (count, model) => count + model.operators.size,
    0,
  );

  return detection(0.99, [
    `${models.length} generated *_calc switch helpers`,
    `${selectorCount} selector-to-operator mappings`,
    "pure binary operator helper topology",
  ]);
}
