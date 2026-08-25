import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

it("recovers a pure function from js-confuser 2.1.3 RGF without executing eval", async () => {
  const source = `
function addTwoNumbers(a, b) {
  return a + b;
}
TEST_OUTPUT = addTwoNumbers(10, 5);
`;
  const obfuscated = await obfuscate213(source, {
    preset: false,
    rgf: true,
    renameGlobals: false,
    renameLabels: false,
    preserveFunctionLength: false,
  });

  expect(obfuscated).toContain("_rgf_eval");

  const result = await decompile(obfuscated);

  expect(result.cleanCode).not.toContain("_rgf_eval");
  expect(result.cleanCode).toMatch(/function\s+addTwoNumbers\s*\(\s*a\s*,\s*b\s*\)/);
  expect(result.cleanCode).toMatch(/return\s+a\s*\+\s*b/);
  expect(result.cleanCode).toContain("TEST_OUTPUT = addTwoNumbers(10, 5)");
  expect(result.report.transforms.rgf).toBeGreaterThanOrEqual(0.9);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});
