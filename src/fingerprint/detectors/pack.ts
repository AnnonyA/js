import * as t from "@babel/types";
import type { DecompilerContext } from "../../core/context.js";
import { detection, type DetectionResult } from "./types.js";

function methodProperty(method: t.ObjectMethod): string | null {
  if (method.computed) {
    return method.key.type === "StringLiteral" ? method.key.value : null;
  }
  if (method.key.type === "Identifier") return method.key.name;
  if (method.key.type === "StringLiteral") return method.key.value;
  return null;
}

function packGetter(method: t.ObjectMethod): { property: string; identifier: string } | null {
  if (method.kind !== "get" || method.params.length !== 0 || method.body.body.length !== 1) {
    return null;
  }
  const property = methodProperty(method);
  const statement = method.body.body[0];
  if (!property || statement?.type !== "ReturnStatement" || !statement.argument) return null;
  if (statement.argument.type === "Identifier") {
    return { property, identifier: statement.argument.name };
  }
  if (
    statement.argument.type === "UnaryExpression" &&
    statement.argument.operator === "typeof" &&
    statement.argument.argument.type === "Identifier"
  ) {
    return { property, identifier: statement.argument.argument.name };
  }
  return null;
}

function isPackInvocation(statement: t.Statement): { mappings: number; setters: number } | null {
  if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") {
    return null;
  }
  const invocation = statement.expression;
  if (
    invocation.arguments.length !== 1 ||
    invocation.arguments[0]?.type !== "ObjectExpression" ||
    invocation.callee.type !== "CallExpression" ||
    invocation.callee.callee.type !== "Identifier" ||
    invocation.callee.callee.name !== "Function" ||
    invocation.callee.arguments.length !== 2
  ) {
    return null;
  }

  const [scopeArgument, payloadArgument] = invocation.callee.arguments;
  if (
    scopeArgument?.type !== "StringLiteral" ||
    payloadArgument?.type !== "StringLiteral" ||
    !scopeArgument.value ||
    !payloadArgument.value.includes(`${scopeArgument.value}[`)
  ) {
    return null;
  }

  const properties = invocation.arguments[0].properties;
  if (properties.length === 0 || properties.some((property) => property.type !== "ObjectMethod")) {
    return null;
  }

  const getters = new Map<string, string>();
  let setters = 0;
  for (const property of properties) {
    if (property.type !== "ObjectMethod") return null;
    if (property.kind === "get") {
      const getter = packGetter(property);
      if (!getter || getters.has(getter.property)) return null;
      getters.set(getter.property, getter.identifier);
      continue;
    }
    if (property.kind === "set") {
      const key = methodProperty(property);
      if (!key || !getters.has(key)) return null;
      setters += 1;
      continue;
    }
    return null;
  }

  return getters.size > 0 ? { mappings: getters.size, setters } : null;
}

export function detectPack(ctx: DecompilerContext): DetectionResult {
  const matches = ctx.inputAst.program.body.flatMap((statement) => {
    const match = isPackInvocation(statement);
    return match ? [match] : [];
  });
  if (matches.length === 0) return detection(0);

  const mappings = matches.reduce((sum, match) => sum + match.mappings, 0);
  const setters = matches.reduce((sum, match) => sum + match.setters, 0);
  return detection(0.98, [
    `${matches.length} Function-constructor wrapper(s) match js-confuser Pack topology`,
    `${mappings} packed global accessor mapping(s)${setters > 0 ? ` with ${setters} setter(s)` : ""}`,
  ]);
}
