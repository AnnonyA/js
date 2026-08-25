import { cloneNode } from "@babel/types";
import type * as t from "@babel/types";

export function normalizeSyntax(ast: t.File): t.File {
  return cloneNode(ast, true);
}
