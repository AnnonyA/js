import type * as t from "@babel/types";

function isNode(value: unknown): value is t.Node {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

function isSignedNumeric(element: t.ArrayExpression["elements"][number]): boolean {
  if (!element) return false;
  if (element.type === "NumericLiteral") return true;
  return (
    element.type === "UnaryExpression" &&
    (element.operator === "-" || element.operator === "+") &&
    element.argument.type === "NumericLiteral"
  );
}

export function hasLargeSignedNumericArray(ast: t.File): boolean {
  let matched = false;

  const walk = (node: t.Node): void => {
    if (matched) return;
    if (node.type === "ArrayExpression" && node.elements.length >= 32) {
      const numeric = node.elements.filter(isSignedNumeric).length;
      if (numeric / node.elements.length >= 0.85) {
        matched = true;
        return;
      }
    }

    for (const value of Object.values(node as unknown as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) walk(child);
      } else if (isNode(value)) {
        walk(value);
      }
    }
  };

  walk(ast);
  return matched;
}
