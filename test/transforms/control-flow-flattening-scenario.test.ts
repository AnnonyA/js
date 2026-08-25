import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as t from "@babel/types";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";

const testDir = dirname(fileURLToPath(import.meta.url));

function fixture(): string {
  return readFileSync(
    resolve(testDir, "../fixtures/2.1.3/controlFlowFlattening/obfuscated.js"),
    "utf8",
  );
}

function visit(node: t.Node, callback: (node: t.Node) => void): void {
  callback(node);
  const record = node as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string") {
          visit(item as t.Node, callback);
        }
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      visit(value as t.Node, callback);
    }
  }
}

function assignedFunction(ast: t.File, property: string): t.FunctionExpression | null {
  let result: t.FunctionExpression | null = null;
  visit(ast.program, (node) => {
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "MemberExpression" &&
      node.left.computed &&
      node.left.property.type === "StringLiteral" &&
      node.left.property.value === property &&
      node.right.type === "FunctionExpression"
    ) {
      result = node.right;
    }
  });
  return result;
}

it("reconstructs the exported scenario CFF wrapper into a clean loop", async () => {
  const result = await decompile(fixture());
  const wrappers = result.report.recovery.cffWrappers as Array<{
    exportName: string;
    scopePath: string[];
  }>;
  const scenarioWrapper = wrappers.find((wrapper) => wrapper.exportName === "scenario");
  const twiceWrapper = wrappers.find((wrapper) => wrapper.exportName === "twice");
  expect(scenarioWrapper).toBeDefined();
  expect(twiceWrapper).toBeDefined();

  const scenarioProperty = scenarioWrapper!.scopePath.at(-1)!;
  const twiceProperty = twiceWrapper!.scopePath.at(-1)!;
  const fn = assignedFunction(parseJavaScript(result.cleanCode), scenarioProperty);
  expect(fn).not.toBeNull();
  expect(fn?.params).toHaveLength(1);
  expect(fn?.params[0]?.type).toBe("Identifier");

  const body = fn!.body.body;
  expect(body).toHaveLength(3);
  expect(body[0]?.type).toBe("VariableDeclaration");
  expect(body[1]?.type).toBe("ForStatement");
  expect(body[2]?.type).toBe("ReturnStatement");

  const currentDecl = body[0] as t.VariableDeclaration;
  const currentId = currentDecl.declarations[0]?.id;
  const currentInit = currentDecl.declarations[0]?.init;
  expect(currentId?.type).toBe("Identifier");
  expect(currentInit?.type).toBe("CallExpression");
  if (currentInit?.type === "CallExpression") {
    expect(currentInit.arguments).toHaveLength(1);
    expect(currentInit.arguments[0]?.type).toBe("Identifier");
    expect(currentInit.callee.type).toBe("MemberExpression");
    if (currentInit.callee.type === "MemberExpression") {
      expect(
        currentInit.callee.computed &&
          currentInit.callee.property.type === "StringLiteral" &&
          currentInit.callee.property.value,
      ).toBe(twiceProperty);
    }
  }

  const loop = body[1] as t.ForStatement;
  expect(loop.init?.type).toBe("VariableDeclaration");
  expect(loop.test?.type).toBe("BinaryExpression");
  expect(loop.update?.type).toBe("UpdateExpression");
  if (loop.test?.type === "BinaryExpression") {
    expect(loop.test.operator).toBe("<");
    expect(loop.test.right.type === "NumericLiteral" && loop.test.right.value).toBe(2);
  }

  const loopBody = loop.body.type === "BlockStatement" ? loop.body.body : [loop.body];
  expect(loopBody).toHaveLength(1);
  expect(loopBody[0]?.type).toBe("ExpressionStatement");
  const expression = (loopBody[0] as t.ExpressionStatement).expression;
  expect(expression.type).toBe("AssignmentExpression");
  if (expression.type === "AssignmentExpression") {
    expect(expression.operator).toBe("=");
    expect(expression.right.type).toBe("BinaryExpression");
    if (expression.right.type === "BinaryExpression") {
      expect(expression.right.operator).toBe("+");
    }
  }

  const finalReturn = body[2] as t.ReturnStatement;
  expect(finalReturn.argument?.type).toBe("Identifier");
  expect(
    currentId?.type === "Identifier" &&
      finalReturn.argument?.type === "Identifier" &&
      currentId.name === finalReturn.argument.name,
  ).toBe(true);

  const bodies = result.report.recovery.cffBodies as Array<{
    exportName: string;
    reconstructed: boolean;
  }>;
  expect(bodies).toContainEqual({ exportName: "scenario", reconstructed: true });
});