import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as t from "@babel/types";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";

const testDir = dirname(fileURLToPath(import.meta.url));

function propertyName(property: t.ObjectProperty): string | null {
  if (property.key.type === "StringLiteral") return property.key.value;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  return null;
}

function cffFixture(): string {
  return readFileSync(
    resolve(testDir, "../fixtures/2.1.3/controlFlowFlattening/obfuscated.js"),
    "utf8",
  );
}

function visitNodes(node: t.Node, callback: (node: t.Node) => void): void {
  callback(node);
  const record = node as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { type?: unknown }).type === "string"
        ) {
          visitNodes(item as t.Node, callback);
        }
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      visitNodes(value as t.Node, callback);
    }
  }
}

function collectExportAliases(ast: t.File): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of ast.program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== "Identifier") continue;
      const init = declaration.init;
      if (
        init?.type !== "MemberExpression" ||
        init.object.type !== "MemberExpression" ||
        init.object.object.type !== "Identifier" ||
        init.object.object.name !== "module" ||
        !init.object.computed ||
        init.object.property.type !== "StringLiteral" ||
        init.object.property.value !== "exports" ||
        !init.computed ||
        init.property.type !== "StringLiteral"
      ) {
        continue;
      }
      aliases.set(declaration.id.name, init.property.value);
    }
  }
  return aliases;
}

function findAssignedFunctionByProperty(
  ast: t.File,
  propertyName: string,
): t.FunctionExpression | null {
  let match: t.FunctionExpression | null = null;
  visitNodes(ast.program, (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "MemberExpression" ||
      !node.left.computed ||
      node.left.property.type !== "StringLiteral" ||
      node.left.property.value !== propertyName ||
      node.right.type !== "FunctionExpression"
    ) {
      return;
    }
    match = node.right;
  });
  return match;
}

function containsIdentifier(node: t.Node, name: string): boolean {
  let found = false;
  visitNodes(node, (candidate) => {
    if (candidate.type === "Identifier" && candidate.name === name) found = true;
  });
  return found;
}

it("traces the 2.1.3 CFF entry state and decodes the exported API", async () => {
  const result = await decompile(cffFixture());
  const ast = parseJavaScript(result.cleanCode);

  expect(result.report.transforms.controlFlowFlattening).toBeGreaterThanOrEqual(0.8);

  let exportedNames: string[] | null = null;
  visitNodes(ast.program, (node) => {
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      node.left.object.type === "Identifier" &&
      node.left.object.name === "module" &&
      node.left.computed &&
      node.left.property.type === "StringLiteral" &&
      node.left.property.value === "exports" &&
      node.right.type === "ObjectExpression"
    ) {
      exportedNames = node.right.properties
        .filter((property): property is t.ObjectProperty => property.type === "ObjectProperty")
        .map(propertyName)
        .filter((name): name is string => Boolean(name))
        .sort();
    }
  });

  expect(exportedNames).toEqual(["add3", "scenario", "twice"]);
});

it("materializes collision-free top-level names for decoded CFF exports", async () => {
  const result = await decompile(cffFixture());
  const aliases = collectExportAliases(parseJavaScript(result.cleanCode));

  expect(Object.fromEntries(aliases)).toEqual({
    add3: "add3",
    twice: "twice",
    scenario: "scenario",
  });
});

it("does not alias an ambiguous second module.exports object", async () => {
  const source = `function unrelated(){module["exports"]={["wrong"]:1}};\n${cffFixture()}`;
  const result = await decompile(source);
  const aliases = collectExportAliases(parseJavaScript(result.cleanCode));

  expect(Object.fromEntries(aliases)).toEqual({});
});

it("also treats dot-notation module.exports objects as ambiguous", async () => {
  const source = `function unrelated(){module.exports={["wrong"]:1}};\n${cffFixture()}`;
  const result = await decompile(source);
  const aliases = collectExportAliases(parseJavaScript(result.cleanCode));

  expect(Object.fromEntries(aliases)).toEqual({});
});

it("models exported CFF wrapper entry states for later body reconstruction", async () => {
  const result = await decompile(cffFixture());
  const wrappers = result.report.recovery.cffWrappers as
    | Array<{
        exportName: string;
        scopePath: string[];
        stateCount: number;
        entrySum: number;
      }>
    | undefined;

  expect(wrappers?.slice().sort((a, b) => a.exportName.localeCompare(b.exportName))).toEqual([
    {
      exportName: "add3",
      scopePath: ["UCRrU7U", "cFzWIDm"],
      stateCount: 90,
      entrySum: -750,
    },
    {
      exportName: "scenario",
      scopePath: ["UCRrU7U", "xfaMJIM"],
      stateCount: 90,
      entrySum: -23,
    },
    {
      exportName: "twice",
      scopePath: ["UCRrU7U", "DrKyAW"],
      stateCount: 90,
      entrySum: -857,
    },
  ]);
});

it("reconstructs the add3 CFF wrapper into a clean function body", async () => {
  const result = await decompile(cffFixture());
  const ast = parseJavaScript(result.cleanCode);
  const add3 = findAssignedFunctionByProperty(ast, "cFzWIDm");

  expect(add3).not.toBeNull();
  expect(add3?.params).toHaveLength(3);
  expect(add3?.params.every((parameter) => parameter.type === "Identifier")).toBe(true);
  expect(containsIdentifier(add3!, "__p_WW9X_4_main")).toBe(false);

  const body = add3!.body.body;
  expect(body).toHaveLength(4);
  expect(body[0]?.type).toBe("VariableDeclaration");
  expect(body[1]?.type).toBe("VariableDeclaration");
  expect(body[2]?.type).toBe("ExpressionStatement");
  expect(body[3]?.type).toBe("ReturnStatement");

  const total = body[0] as t.VariableDeclaration;
  const label = body[1] as t.VariableDeclaration;
  const totalInit = total.declarations[0]?.init;
  const labelInit = label.declarations[0]?.init;
  expect(totalInit?.type).toBe("BinaryExpression");
  expect(labelInit?.type).toBe("ConditionalExpression");

  const conditional = labelInit as t.ConditionalExpression;
  expect(conditional.test.type).toBe("BinaryExpression");
  expect(conditional.test.type === "BinaryExpression" && conditional.test.operator).toBe(">");
  expect(
    conditional.test.type === "BinaryExpression" &&
      conditional.test.right.type === "NumericLiteral" &&
      conditional.test.right.value,
  ).toBe(5);
  expect(
    [conditional.consequent, conditional.alternate]
      .filter((node): node is t.StringLiteral => node.type === "StringLiteral")
      .map((node) => node.value)
      .sort(),
  ).toEqual(["large", "small"]);

  const log = body[2] as t.ExpressionStatement;
  expect(log.expression.type).toBe("CallExpression");
  if (log.expression.type === "CallExpression") {
    expect(log.expression.callee.type).toBe("MemberExpression");
    if (log.expression.callee.type === "MemberExpression") {
      expect(log.expression.callee.object.type === "Identifier" && log.expression.callee.object.name).toBe(
        "console",
      );
      expect(
        !log.expression.callee.computed &&
          log.expression.callee.property.type === "Identifier" &&
          log.expression.callee.property.name,
      ).toBe("log");
    }
  }

  expect(result.report.recovery.cffBodies).toContainEqual({
    exportName: "add3",
    reconstructed: true,
  });
});

it("does not treat an ordinary while-switch state machine as js-confuser CFF", async () => {
  const source = `
let state = 0;
while (state !== 2) {
  switch (state) {
    case 0:
      state = 1;
      break;
    case 1:
      state = 2;
      break;
  }
}
module.exports = state;
`;

  const result = await decompile(source);
  expect(result.cleanCode).toContain("while (state !== 2)");
  expect(result.cleanCode).toContain("switch (state)");
});
