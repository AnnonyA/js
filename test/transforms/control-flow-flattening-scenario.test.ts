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

function containsIdentifier(node: t.Node, name: string): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (candidate.type === "Identifier" && candidate.name === name) found = true;
  });
  return found;
}

it("reconstructs the exported scenario CFF wrapper into a clean loop", async () => {
  const result = await decompile(fixture());
  const wrappers = result.report.recovery.cffWrappers as Array<{
    exportName: string;
    scopePath: string[];
  }>;
  const scenarioWrapper = wrappers.find((wrapper) => wrapper.exportName === "scenario");
  expect(scenarioWrapper).toBeDefined();

  const property = scenarioWrapper!.scopePath.at(-1)!;
  const fn = assignedFunction(parseJavaScript(result.cleanCode), property);
  expect(fn).not.toBeNull();
  expect(fn?.params).toHaveLength(1);
  expect(fn?.params[0]?.type).toBe("Identifier");
  expect(containsIdentifier(fn!, "__p_WW9X_4_main")).toBe(false);

  const body = fn!.body.body;
  expect(body).toHaveLength(3);
  expect(body[0]?.type).toBe("VariableDeclaration");
  expect(body[1]?.type).toBe("ForStatement");
  expect(body[2]?.type).toBe("ReturnStatement");

  const first = (body[0] as t.VariableDeclaration).declarations[0]?.init;
  expect(first?.type).toBe("CallExpression");
  if (first?.type === "CallExpression") {
    expect(first.arguments).toHaveLength(1);
    expect(first.arguments[0]?.type).toBe("Identifier");
  }

  const loop = body[1] as t.ForStatement;
  expect(loop.init?.type).toBe("VariableDeclaration");
  if (loop.init?.type === "VariableDeclaration") {
    const init = loop.init.declarations[0];
    expect(init?.id.type).toBe("Identifier");
    expect(init?.init?.type === "NumericLiteral" && init.init.value).toBe(0);
  }
  expect(loop.test?.type).toBe("BinaryExpression");
  if (loop.test?.type === "BinaryExpression") {
    expect(loop.test.operator).toBe("<");
    expect(loop.test.right.type === "NumericLiteral" && loop.test.right.value).toBe(2);
  }
  expect(loop.update?.type).toBe("UpdateExpression");
  if (loop.update?.type === "UpdateExpression") {
    expect(loop.update.operator).toBe("++");
  }

  const loopBody = loop.body.type === "BlockStatement" ? loop.body.body : [loop.body];
  expect(loopBody).toHaveLength(1);
  expect(loopBody[0]?.type).toBe("ExpressionStatement");
  if (loopBody[0]?.type === "ExpressionStatement") {
    expect(loopBody[0].expression.type).toBe("AssignmentExpression");
    if (loopBody[0].expression.type === "AssignmentExpression") {
      expect(loopBody[0].expression.operator).toBe("=");
      expect(loopBody[0].expression.right.type).toBe("BinaryExpression");
      if (loopBody[0].expression.right.type === "BinaryExpression") {
        expect(loopBody[0].expression.right.operator).toBe("+");
      }
    }
  }

  const finalReturn = body[2] as t.ReturnStatement;
  expect(finalReturn.argument?.type).toBe("Identifier");

  const bodies = result.report.recovery.cffBodies as Array<{
    exportName: string;
    reconstructed: boolean;
  }>;
  expect(bodies).toContainEqual({ exportName: "add3", reconstructed: true });
  expect(bodies).toContainEqual({ exportName: "twice", reconstructed: true });
  expect(bodies).toContainEqual({ exportName: "scenario", reconstructed: true });
});
