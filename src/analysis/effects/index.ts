import * as t from "@babel/types";
import type { AstPathLike } from "../constants/index.js";

export type SideEffectClass = "pure" | "impure" | "unknown";

const PURE_MATH_METHODS = new Set([
  "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh",
  "cbrt", "ceil", "clz32", "cos", "cosh", "exp", "expm1", "floor",
  "fround", "hypot", "imul", "log", "log10", "log1p", "log2", "max",
  "min", "pow", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh",
  "trunc",
]);

function combine(...classes: SideEffectClass[]): SideEffectClass {
  if (classes.includes("impure")) return "impure";
  if (classes.includes("unknown")) return "unknown";
  return "pure";
}

function classifyNode(node: t.Node): SideEffectClass {
  if (
    t.isLiteral(node) ||
    t.isIdentifier(node) ||
    t.isThisExpression(node) ||
    t.isSuper(node)
  ) {
    return "pure";
  }

  if (t.isAssignmentExpression(node) || t.isUpdateExpression(node)) return "impure";
  if (
    t.isNewExpression(node) ||
    t.isAwaitExpression(node) ||
    t.isYieldExpression(node)
  ) {
    return "impure";
  }

  if (t.isCallExpression(node)) {
    if (
      t.isMemberExpression(node.callee) &&
      !node.callee.computed &&
      t.isIdentifier(node.callee.object, { name: "Math" }) &&
      t.isIdentifier(node.callee.property) &&
      PURE_MATH_METHODS.has(node.callee.property.name)
    ) {
      return combine(
        ...node.arguments.map((argument) =>
          t.isSpreadElement(argument) || t.isJSXNamespacedName(argument)
            ? "unknown"
            : classifyNode(argument),
        ),
      );
    }
    return "impure";
  }

  if (t.isUnaryExpression(node)) {
    if (node.operator === "delete") return "impure";
    return classifyNode(node.argument);
  }
  if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
    return combine(classifyNode(node.left), classifyNode(node.right));
  }
  if (t.isConditionalExpression(node)) {
    return combine(
      classifyNode(node.test),
      classifyNode(node.consequent),
      classifyNode(node.alternate),
    );
  }
  if (t.isSequenceExpression(node)) {
    return combine(...node.expressions.map(classifyNode));
  }

  return "unknown";
}

export function classifySideEffects(path: AstPathLike): SideEffectClass {
  return classifyNode(path.node);
}
