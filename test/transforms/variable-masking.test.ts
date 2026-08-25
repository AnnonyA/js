import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

const baseline = {
  preset: false as const,
  renameLabels: false,
  renameGlobals: false,
  preserveFunctionLength: false,
};

it("restores a 2.1.3 variable-masked function to normal parameters and locals", async () => {
  const source = `
module.exports = function masked(a, b) {
  let total = a + b;
  var doubled = total * 2;
  total = doubled + 1;
  return total + b;
};
`;
  const obfuscated = await obfuscate213(source, {
    ...baseline,
    variableMasking: true,
  });
  expect(obfuscated).toMatch(/_varMask/);

  const result = await decompile(obfuscated);

  expect(result.report.transforms.variableMasking).toBeGreaterThan(0.5);
  expect(result.cleanCode).not.toMatch(/_varMask/);
  expect(result.cleanCode).not.toMatch(/\.\.\./);
  expect(result.cleanCode).toMatch(/function masked\([^)]*,[^)]*\)/);
  expect(result.cleanCode).toMatch(/(?:let|var) local0\s*=/);
  expect(result.cleanCode).toContain("return");
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("does not rewrite an ordinary user rest-parameter function", async () => {
  const source = `
module.exports = function manual(...stack) {
  stack.length = 2;
  return stack[0] + stack[1];
};
`;
  const result = await decompile(source);

  expect(result.cleanCode).toContain("...stack");
  expect(result.cleanCode).toContain("stack.length = 2");
});
