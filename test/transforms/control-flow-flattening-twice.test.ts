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

it("reconstructs the exported twice CFF wrapper into a clean branch", async () => {
  const result = await decompile(fixture());
  const wrappers = result.report.recovery.cffWrappers as Array<{
    exportName: string;
    scopePath: string[];
  }>;
  const twiceWrapper = wrappers.find((wrapper) => wrapper.exportName === "twice");
  expect(twiceWrapper).toBeDefined();

  const property = twiceWrapper!.scopePath.at(-1)!;
  const fn = assignedFunction(parseJavaScript(result.cleanCode), property);
  expect(fn).not.toBeNull();
  expect(fn?.params).toHaveLength(1);
  expect(fn?.params[0]?.type).toBe("Identifier");
  expect(containsIdentifier(fn!, "__p_WW9X_4_main")).toBe(false);

  const body = fn!.body.body;
  expect(body).toHaveLength(3);
  expect(body[0]?.type).toBe("VariableDeclaration");
  expect(body[1]?.type).toBe("IfStatement");
  expect(body[2]?.type).toBe("ReturnStatement");

  const first = (body[0] as t.VariableDeclaration).declarations[0]?.init;
  expect(first?.type).toBe("CallExpression");
  if (first?.type === "CallExpression") {
    expect(first.arguments).toHaveLength(3);
    expect(first.arguments[0]?.type).toBe("Identifier");
    expect(first.arguments[1]?.type).toBe("Identifier");
    expect(
      first.arguments[0]?.type === "Identifier" &&
        first.arguments[1]?.type === "Identifier" &&
        first.arguments[0].name === first.arguments[1].name,
    ).toBe(true);
    expect(first.arguments[2]?.type === "NumericLiteral" && first.arguments[2].value).toBe(0);
  }

  const branch = body[1] as t.IfStatement;
  expect(branch.test.type).toBe("BinaryExpression");
  if (branch.test.type === "BinaryExpression") {
    expect(branch.test.operator).toBe("===");
    expect(branch.test.left.type).toBe("BinaryExpression");
    if (branch.test.left.type === "BinaryExpression") {
      expect(branch.test.left.operator).toBe("%");
      expect(
        branch.test.left.right.type === "NumericLiteral" && branch.test.left.right.value,
      ).toBe(2);
    }
    expect(branch.test.right.type === "NumericLiteral" && branch.test.right.value).toBe(0);
  }

  const consequent = branch.consequent.type === "BlockStatement"
    ? branch.consequent.body[0]
    : branch.consequent;
  expect(consequent?.type).toBe("ReturnStatement");
  if (consequent?.type === "ReturnStatement") {
    expect(consequent.argument?.type).toBe("BinaryExpression");
    if (consequent.argument?.type === "BinaryExpression") {
      expect(consequent.argument.operator).toBe("*");
      expect(
        consequent.argument.right.type === "NumericLiteral" && consequent.argument.right.value,
      ).toBe(2);
    }
  }

  const finalReturn = body[2] as t.ReturnStatement;
  expect(finalReturn.argument?.type).toBe("BinaryExpression");
  if (finalReturn.argument?.type === "BinaryExpression") {
    expect(finalReturn.argument.operator).toBe("+");
    expect(
      finalReturn.argument.right.type === "NumericLiteral" && finalReturn.argument.right.value,
    ).toBe(1);
  }

  const bodies = result.report.recovery.cffBodies as Array<{
    exportName: string;
    reconstructed: boolean;
  }>;
  expect(bodies).toContainEqual({
    exportName: "twice",
    reconstructed: true,
  });
});
