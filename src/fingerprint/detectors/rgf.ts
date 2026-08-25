import type * as t from "@babel/types";
import type { DecompilerContext } from "../../core/context.js";
import { detection, type DetectionResult } from "./types.js";

function isEvalPayloadElement(node: t.Expression | t.SpreadElement | null): string | null {
  if (
    !node ||
    node.type !== "CallExpression" ||
    node.callee.type !== "Identifier" ||
    node.arguments.length !== 1 ||
    node.arguments[0]?.type !== "StringLiteral"
  ) {
    return null;
  }
  const code = node.arguments[0].value;
  return code.includes("_embedded") && code.includes("_replacement") && code.includes("arguments")
    ? node.callee.name
    : null;
}

export function detectRgf(ctx: DecompilerContext): DetectionResult {
  let arrays = 0;
  let payloads = 0;
  const evalNames = new Set<string>();

  for (const statement of ctx.inputAst.program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type !== "Identifier" || declarator.init?.type !== "ArrayExpression") continue;
      if (declarator.init.elements.length === 0) continue;

      const names = declarator.init.elements.map(isEvalPayloadElement);
      if (names.some((name) => !name)) continue;
      const unique = new Set(names as string[]);
      if (unique.size !== 1) continue;
      arrays += 1;
      payloads += names.length;
      evalNames.add(names[0]!);
    }
  }

  if (arrays === 0) return detection(0);

  let helpers = 0;
  for (const statement of ctx.inputAst.program.body) {
    if (
      statement.type === "FunctionDeclaration" &&
      statement.id &&
      evalNames.has(statement.id.name)
    ) {
      helpers += 1;
    }
  }

  const confidence = helpers === evalNames.size ? 0.98 : 0.88;
  return detection(confidence, [
    `${arrays} RGF array(s) contain ${payloads} embedded replacement-function payload(s)`,
    `${helpers}/${evalNames.size} referenced RGF eval helper(s) are declared in the program`,
  ]);
}
