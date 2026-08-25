import * as t from "@babel/types";

export interface AstPathLike {
  node: t.Node;
}

export type ConstantResult =
  | { confident: true; value: unknown }
  | { confident: false };

const unknown: ConstantResult = { confident: false };

function evaluateNode(node: t.Node): ConstantResult {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) {
    return { confident: true, value: node.value };
  }
  if (t.isNullLiteral(node)) return { confident: true, value: null };

  if (t.isUnaryExpression(node)) {
    const argument = evaluateNode(node.argument);
    if (!argument.confident) return unknown;
    const value = argument.value as any;
    switch (node.operator) {
      case "+": return { confident: true, value: +value };
      case "-": return { confident: true, value: -value };
      case "!": return { confident: true, value: !value };
      case "~": return { confident: true, value: ~value };
      case "void": return { confident: true, value: undefined };
      case "typeof": return { confident: true, value: typeof value };
      default: return unknown;
    }
  }

  if (t.isBinaryExpression(node)) {
    const leftResult = evaluateNode(node.left);
    const rightResult = evaluateNode(node.right);
    if (!leftResult.confident || !rightResult.confident) return unknown;
    const left = leftResult.value as any;
    const right = rightResult.value as any;
    try {
      switch (node.operator) {
        case "+": return { confident: true, value: left + right };
        case "-": return { confident: true, value: left - right };
        case "*": return { confident: true, value: left * right };
        case "/": return { confident: true, value: left / right };
        case "%": return { confident: true, value: left % right };
        case "**": return { confident: true, value: left ** right };
        case "<<": return { confident: true, value: left << right };
        case ">>": return { confident: true, value: left >> right };
        case ">>>": return { confident: true, value: left >>> right };
        case "|": return { confident: true, value: left | right };
        case "&": return { confident: true, value: left & right };
        case "^": return { confident: true, value: left ^ right };
        case "==": return { confident: true, value: left == right };
        case "!=": return { confident: true, value: left != right };
        case "===": return { confident: true, value: left === right };
        case "!==": return { confident: true, value: left !== right };
        case "<": return { confident: true, value: left < right };
        case "<=": return { confident: true, value: left <= right };
        case ">": return { confident: true, value: left > right };
        case ">=": return { confident: true, value: left >= right };
        default: return unknown;
      }
    } catch {
      return unknown;
    }
  }

  if (t.isLogicalExpression(node)) {
    const left = evaluateNode(node.left);
    if (!left.confident) return unknown;
    if (node.operator === "&&") {
      if (!left.value) return { confident: true, value: left.value };
      return evaluateNode(node.right);
    }
    if (node.operator === "||") {
      if (left.value) return { confident: true, value: left.value };
      return evaluateNode(node.right);
    }
    if (node.operator === "??") {
      if (left.value !== null && left.value !== undefined) {
        return { confident: true, value: left.value };
      }
      return evaluateNode(node.right);
    }
  }

  if (t.isConditionalExpression(node)) {
    const test = evaluateNode(node.test);
    if (!test.confident) return unknown;
    return evaluateNode(test.value ? node.consequent : node.alternate);
  }

  return unknown;
}

export function evaluateConstant(path: AstPathLike): ConstantResult {
  return evaluateNode(path.node);
}
