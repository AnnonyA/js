import { cloneNode } from "@babel/types";
import type * as t from "@babel/types";
import type { PassActionRecord } from "./provenance.js";
import type { DecompilerContext } from "./context.js";
import { validateSyntax, type ValidationResult } from "../validation/syntax.js";

export type AstBranch = "safe" | "clean";

export interface TransactionMetadata {
  passId: string;
  action: string;
  range?: { start: number; end: number };
  confidence: number;
  evidence: string[];
}

export interface TransactionResult {
  committed: boolean;
  validation: ValidationResult;
  record: PassActionRecord;
}

export function runAstTransaction(
  ctx: DecompilerContext,
  branch: AstBranch,
  metadata: TransactionMetadata,
  mutate: (candidate: t.File) => void,
): TransactionResult {
  const current = branch === "safe" ? ctx.safeAst : ctx.cleanAst;
  const candidate = cloneNode(current, true);

  let validation: ValidationResult;
  try {
    mutate(candidate);
    validation = validateSyntax(candidate);
  } catch (error) {
    validation = {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const record: PassActionRecord = {
    passId: metadata.passId,
    action: metadata.action,
    ...(metadata.range ? { range: metadata.range } : {}),
    confidence: Math.max(0, Math.min(1, metadata.confidence)),
    evidence: [...metadata.evidence],
    validation: validation.valid ? "passed" : "failed",
    rolledBack: !validation.valid,
  };
  ctx.report.passes.push(record);

  if (validation.valid) {
    if (branch === "safe") {
      ctx.safeAst = candidate;
    } else {
      ctx.cleanAst = candidate;
    }
  } else {
    const diagnostic = ctx.diagnostics.warn(
      "PASS_TRANSFORM_FAILED",
      `Rolled back ${metadata.passId}: ${metadata.action}`,
      {
        passId: metadata.passId,
        ...(metadata.range ? { range: metadata.range } : {}),
        ...(validation.error ? { cause: validation.error } : {}),
      },
    );
    ctx.report.warnings.push(diagnostic);
  }

  return {
    committed: validation.valid,
    validation,
    record,
  };
}
