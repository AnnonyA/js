import type { DecompilerContext } from "../core/context.js";
import { detectCalculator } from "./detectors/calculator.js";
import { detectObjectExtraction } from "./detectors/objectExtraction.js";
import { detectStringConcealing } from "./detectors/stringConcealing.js";
import {
  detectControlFlowFlattening,
  detectDeadCode,
  detectDispatcher,
  detectGlobalConcealing,
  detectOpaquePredicates,
  detectRenameVariables,
  detectVariableMasking,
} from "./detectors/structural.js";
import { detection, type DetectionResult } from "./detectors/types.js";

export const TRANSFORM_IDS = [
  "pack",
  "stringConcealing",
  "stringSplitting",
  "calculator",
  "duplicateLiteralsRemoval",
  "objectExtraction",
  "globalConcealing",
  "variableMasking",
  "dispatcher",
  "rgf",
  "controlFlowFlattening",
  "opaquePredicates",
  "deadCode",
  "locks",
  "renameVariables",
  "minify",
] as const;

export type TransformId = (typeof TRANSFORM_IDS)[number];
export type TransformDetections = Record<TransformId, DetectionResult>;

const NEUTRAL = () => detection(0);

export function detectTransforms(ctx: DecompilerContext): TransformDetections {
  return {
    pack: NEUTRAL(),
    stringConcealing: detectStringConcealing(ctx),
    stringSplitting: NEUTRAL(),
    calculator: detectCalculator(ctx),
    duplicateLiteralsRemoval: NEUTRAL(),
    objectExtraction: detectObjectExtraction(ctx),
    globalConcealing: detectGlobalConcealing(ctx),
    variableMasking: detectVariableMasking(ctx),
    dispatcher: detectDispatcher(ctx),
    rgf: NEUTRAL(),
    controlFlowFlattening: detectControlFlowFlattening(ctx),
    opaquePredicates: detectOpaquePredicates(ctx),
    deadCode: detectDeadCode(ctx),
    locks: NEUTRAL(),
    renameVariables: detectRenameVariables(ctx),
    minify: NEUTRAL(),
  };
}

export type { DetectionResult } from "./detectors/types.js";
