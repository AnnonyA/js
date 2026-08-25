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

it("traces the 2.1.3 CFF entry state and decodes the exported API", async () => {
  const result = await decompile(cffFixture());
  const ast = parseJavaScript(result.cleanCode);

  expect(result.report.transforms.controlFlowFlattening).toBeGreaterThanOrEqual(0.8);

  let exportedNames: string[] | null = null;
  const visit = (node: t.Node): void => {
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

    const record = node as unknown as Record<string, unknown>;
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (
            item &&
            typeof item === "object" &&
            typeof (item as { type?: unknown }).type === "string"
          ) {
            visit(item as t.Node);
          }
        }
      } else if (
        value &&
        typeof value === "object" &&
        typeof (value as { type?: unknown }).type === "string"
      ) {
        visit(value as t.Node);
      }
    }
  };

  visit(ast.program);
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
