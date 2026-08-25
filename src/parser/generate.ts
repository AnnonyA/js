import generate from "@babel/generator";
import type * as t from "@babel/types";

export function generateJavaScript(ast: t.File): string {
  return `${generate(ast, {
    comments: true,
    compact: false,
    retainLines: false,
  }).code}\n`;
}
