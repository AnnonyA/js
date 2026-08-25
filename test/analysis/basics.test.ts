import { expect, it } from "vitest";
import traverseModule from "@babel/traverse";
import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { analyzeBindings } from "../../src/analysis/bindings/index.js";
import { evaluateConstant } from "../../src/analysis/constants/index.js";
import { classifySideEffects } from "../../src/analysis/effects/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";

const traverse = ((traverseModule as unknown as { default?: unknown }).default ??
  traverseModule) as unknown as (
  ast: t.Node,
  visitors: Record<string, (path: NodePath<t.Node>) => void>,
) => void;

it("analyzes bindings, constants, and conservative side effects", () => {
  const ast = parseJavaScript("const a = 2 + 3; const b = a; foo();");
  let addition: NodePath<t.Node> | undefined;
  let call: NodePath<t.Node> | undefined;

  traverse(ast, {
    BinaryExpression(path) {
      addition ??= path;
    },
    CallExpression(path) {
      call ??= path;
    },
  });

  expect(addition).toBeDefined();
  expect(call).toBeDefined();
  expect(evaluateConstant(addition!)).toEqual({ confident: true, value: 5 });

  const summary = analyzeBindings(ast);
  expect(summary.bindings.a).toMatchObject({ count: 1, references: 1 });
  expect(classifySideEffects(call!)).toBe("impure");
});
