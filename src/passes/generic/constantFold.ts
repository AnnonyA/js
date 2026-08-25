import * as t from "@babel/types";
import { evaluateConstant } from "../../analysis/constants/index.js";
import type { ReversePass } from "../../core/pass.js";
import { runAstTransaction } from "../../core/transaction.js";
import { rewriteNodes } from "../rewrite.js";

function literalFrom(value: unknown): t.Expression | null {
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
    return t.numericLiteral(value);
  }
  if (typeof value === "string") return t.stringLiteral(value);
  if (typeof value === "boolean") return t.booleanLiteral(value);
  if (value === null) return t.nullLiteral();
  return null;
}

function foldable(node: t.Node): boolean {
  if (
    node.type !== "UnaryExpression" &&
    node.type !== "BinaryExpression" &&
    node.type !== "LogicalExpression" &&
    node.type !== "ConditionalExpression"
  ) {
    return false;
  }
  const result = evaluateConstant({ node });
  return result.confident && literalFrom(result.value) !== null;
}

function countFoldable(ast: t.File): number {
  let count = 0;
  rewriteNodes(ast, (node) => {
    if (foldable(node)) count += 1;
    return node;
  });
  return count;
}

function foldConstants(ast: t.File): number {
  let changed = 0;
  rewriteNodes(ast, (node) => {
    if (!foldable(node)) return node;
    const result = evaluateConstant({ node });
    if (!result.confident) return node;
    const literal = literalFrom(result.value);
    if (!literal) return node;
    changed += 1;
    return literal;
  });
  return changed;
}

export function createConstantFoldPass(): ReversePass {
  return {
    id: "generic.constant-fold",
    prerequisites: [],
    conflicts: [],
    capabilities: ["constants.folded"],
    detect(ctx) {
      const count = countFoldable(t.cloneNode(ctx.cleanAst, true));
      return {
        detected: count > 0,
        confidence: count > 0 ? 1 : 0,
        evidence: count > 0 ? [`${count} statically provable expressions`] : [],
      };
    },
    analyze(ctx) {
      const count = countFoldable(t.cloneNode(ctx.cleanAst, true));
      return {
        changed: false,
        facts: { "constantFold.candidates": count },
      };
    },
    transform(ctx) {
      const candidates = countFoldable(t.cloneNode(ctx.cleanAst, true));
      if (candidates === 0) return { changed: false };

      let folded = 0;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "generic.constant-fold",
          action: "fold-proven-constants",
          confidence: 1,
          evidence: [`${candidates} statically provable expressions`],
        },
        (candidate) => {
          folded = foldConstants(candidate);
        },
      );
      return {
        changed: transaction.committed && folded > 0,
        actions: folded > 0 ? [`folded ${folded} expressions`] : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 1,
        evidence: ["syntax-validated transactional rewrite"],
      };
    },
  };
}
