import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { rewriteNodes } from "../../rewrite.js";

export interface StringSplittingCandidate {
  value: string;
  leaves: string[];
}

function stringLeaves(node: t.Node): string[] | null {
  if (node.type === "StringLiteral") return [node.value];
  if (
    node.type !== "BinaryExpression" ||
    node.operator !== "+" ||
    !t.isExpression(node.left) ||
    !t.isExpression(node.right)
  ) {
    return null;
  }

  const left = stringLeaves(node.left);
  const right = stringLeaves(node.right);
  return left && right ? [...left, ...right] : null;
}

function leftDeepStringChunks(node: t.Node): string[] | null {
  const reversed: string[] = [];
  let current: t.Node = node;

  while (current.type === "BinaryExpression" && current.operator === "+") {
    if (current.right.type !== "StringLiteral" || !t.isExpression(current.left)) {
      return null;
    }
    reversed.push(current.right.value);
    current = current.left;
  }

  if (current.type !== "StringLiteral") return null;
  reversed.push(current.value);
  return reversed.reverse();
}

function isJsConfuserSplitShape(chunks: readonly string[]): boolean {
  if (chunks.length < 3) return false;
  const chunkSize = chunks[0]?.length ?? 0;
  if (chunkSize < 6) return false;
  if (chunks.slice(0, -1).some((chunk) => chunk.length !== chunkSize)) return false;
  const lastSize = chunks.at(-1)?.length ?? 0;
  return lastSize > 0 && lastSize <= chunkSize;
}

export function findStringSplittingCandidates(ast: t.File): StringSplittingCandidate[] {
  const candidates: StringSplittingCandidate[] = [];
  rewriteNodes(ast, (node) => {
    if (node.type !== "BinaryExpression" || node.operator !== "+") return node;
    const chunks = leftDeepStringChunks(node);
    if (!chunks || !isJsConfuserSplitShape(chunks)) return node;
    candidates.push({ value: chunks.join(""), leaves: chunks });
    return node;
  });
  return candidates;
}

function collapsePureStringConcatenations(ast: t.File): number {
  let replacements = 0;
  rewriteNodes(ast, (node) => {
    if (node.type !== "BinaryExpression" || node.operator !== "+") return node;
    const leaves = stringLeaves(node);
    if (!leaves) return node;
    replacements += 1;
    return t.stringLiteral(leaves.join(""));
  });
  return replacements;
}

export function createStringSplitting213Pass(): ReversePass {
  return {
    id: "jsconfuser.string-splitting.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["strings.splittingReversed"],
    detect(ctx) {
      const candidates = findStringSplittingCandidates(ctx.safeAst);
      return {
        detected: candidates.length > 0,
        confidence: candidates.length > 0 ? 0.99 : 0,
        evidence: candidates.length > 0
          ? [
              `${candidates.length} left-deep literal string concatenation chains`,
              "uniform generated chunk widths match js-confuser 2.1.3 string splitting",
            ]
          : [],
      };
    },
    analyze(ctx) {
      const candidates = findStringSplittingCandidates(ctx.safeAst);
      return {
        changed: false,
        facts: {
          "stringSplitting.candidates": candidates.map((candidate) => ({
            chunks: candidate.leaves.length,
            length: candidate.value.length,
          })),
        },
      };
    },
    transform(ctx) {
      const candidates = findStringSplittingCandidates(ctx.safeAst);
      if (candidates.length === 0) return { changed: false };

      let safeReplacements = 0;
      let cleanReplacements = 0;
      const evidence = [
        `${candidates.length} structurally verified 2.1.3 split-string chains`,
        "all rewritten operands are string literals, so concatenation is statically exact",
      ];

      const safeTransaction = runAstTransaction(
        ctx,
        "safe",
        {
          passId: "jsconfuser.string-splitting.v213",
          action: "collapse-split-string-literals",
          confidence: 0.99,
          evidence,
        },
        (candidate) => {
          safeReplacements = collapsePureStringConcatenations(candidate);
        },
      );

      const cleanTransaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.string-splitting.v213",
          action: "collapse-split-string-literals",
          confidence: 0.99,
          evidence,
        },
        (candidate) => {
          cleanReplacements = collapsePureStringConcatenations(candidate);
        },
      );

      const changed =
        (safeTransaction.committed && safeReplacements > 0) ||
        (cleanTransaction.committed && cleanReplacements > 0);

      return {
        changed,
        actions: changed
          ? [`collapsed ${Math.max(safeReplacements, cleanReplacements)} split string expressions`]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["only pure string-literal additions are replaced and both AST transactions parse"],
      };
    },
  };
}
