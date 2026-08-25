import type * as t from "@babel/types";

function isNode(value: unknown): value is t.Node {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

export type NodeRewriter = (node: t.Node) => t.Node;

export function rewriteNodes(root: t.Node, rewrite: NodeRewriter): t.Node {
  const record = root as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      record[key] = value.map((item) =>
        isNode(item) ? rewriteNodes(item, rewrite) : item,
      );
    } else if (isNode(value)) {
      record[key] = rewriteNodes(value, rewrite);
    }
  }
  return rewrite(root);
}

export function countNodes(root: t.Node, predicate: (node: t.Node) => boolean): number {
  let count = 0;
  rewriteNodes(root, (node) => {
    if (predicate(node)) count += 1;
    return node;
  });
  return count;
}
