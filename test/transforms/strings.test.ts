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

it("recovers statically decodable 2.1.3 concealed strings", async () => {
  const source = `
module.exports = function strings() {
  const object = { "greeting-key": "Hello repeated" };
  return [
    "Hello repeated",
    object["greeting-key"],
    "Unicode 世界🌍",
    ""
  ];
};
`;
  const obfuscated = await obfuscate213(source, {
    ...baseline,
    stringConcealing: true,
  });
  expect(obfuscated).toMatch(/_MAIN_STR/);

  const result = await decompile(obfuscated);

  expect(result.report.transforms.stringConcealing).toBeGreaterThanOrEqual(0.8);
  expect(result.cleanCode).toContain("Hello repeated");
  expect(result.cleanCode).toContain("greeting-key");
  expect(result.cleanCode).toContain("Unicode 世界🌍");
  expect(result.cleanCode).not.toMatch(/_MAIN_STR\s*\(/);
  expect(() => parseJavaScript(result.safeCode)).not.toThrow();
});

it("restores duplicate literal array reads and removes the unused table", async () => {
  const source = `
module.exports = function duplicateLiterals() {
  const a = "repeat-value";
  const b = "repeat-value";
  const c = 1337;
  const d = 1337;
  return [a, b, c, d, ""];
};
`;
  const obfuscated = await obfuscate213(source, {
    ...baseline,
    duplicateLiteralsRemoval: true,
  });
  expect(obfuscated).toMatch(/_dlrArray/);

  const result = await decompile(obfuscated);

  expect(result.cleanCode).toContain("repeat-value");
  expect(result.cleanCode).toContain("1337");
  expect(result.cleanCode).not.toMatch(/_dlrArray/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});
