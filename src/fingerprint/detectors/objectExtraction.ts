import type { DecompilerContext } from "../../core/context.js";
import { findExtractedObjectModels } from "../../passes/jsconfuser/extraction/objectExtraction.js";
import { detection, type DetectionResult } from "./types.js";

export function detectObjectExtraction(ctx: DecompilerContext): DetectionResult {
  const models = findExtractedObjectModels(ctx.inputAst);
  if (models.length === 0) return detection(0);

  const properties = models.reduce(
    (count, model) => count + model.properties.length,
    0,
  );
  return detection(0.92, [
    `${models.length} generated extracted-object identifier families`,
    `${properties} contiguous extracted property bindings`,
    "__p_<token>_<object>_<property> topology",
  ]);
}
