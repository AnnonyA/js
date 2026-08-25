import type * as t from "@babel/types";

export function isNode(value: unknown): value is t.Node {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

export function walk(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node);
  for (const value of Object.values(node as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

export function propertyName(node: t.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property.type === "StringLiteral") {
    return node.property.value;
  }
  return null;
}

export function isEmptyFunction(node: t.FunctionDeclaration): boolean {
  return node.body.body.length === 0;
}
