import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

const calculatorOptions = {
  preset: false as const,
  renameLabels: false,
  renameGlobals: false,
  preserveFunctionLength: false,
  calculator: true,
};

it("reverses the 2.1.3 calculator helper and folds proven constants", async () => {
  const source = `
module.exports = function calculate() {
  const a = 2 + 3;
  const b = 8 - 1;
  const c = 4 * 5;
  const d = 20 / 4;
  return a + b + c + d;
};
`;
  const obfuscated = await obfuscate213(source, calculatorOptions);
  expect(obfuscated).toMatch(/_calc/);

  const result = await decompile(obfuscated);

  expect(result.report.transforms.calculator).toBeGreaterThanOrEqual(0.8);
  expect(result.cleanCode).not.toMatch(/_calc/);
  expect(result.cleanCode).toContain("const a = 5;");
  expect(result.cleanCode).toContain("const b = 7;");
  expect(result.cleanCode).toContain("const c = 20;");
  expect(result.cleanCode).toContain("const d = 5;");
  expect(() => parseJavaScript(result.safeCode)).not.toThrow();
});

it("does not rewrite a user calculator with side effects", async () => {
  const source = `
let sideEffects = 0;
function userCalculator(operator, a, b) {
  sideEffects++;
  switch (operator) {
    case "plus": return a + b;
    default: return 0;
  }
}
module.exports = userCalculator("plus", 2, 3);
`;
  const result = await decompile(source);

  expect(result.report.transforms.calculator).toBeLessThan(0.5);
  expect(result.cleanCode).toContain("sideEffects++");
  expect(result.cleanCode).toContain("userCalculator(\"plus\", 2, 3)");
});
