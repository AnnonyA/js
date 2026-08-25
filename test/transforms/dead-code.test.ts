import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

const baseline = {
  preset: false as const,
  renameLabels: false,
  renameGlobals: false,
  renameVariables: false,
  minify: false,
  preserveFunctionLength: false,
};

it("removes unreachable 2.1.3 dead-code scaffolding in safe and clean output", async () => {
  const source = `
module.exports = function compute(value) {
  const doubled = value * 2;
  return doubled + 1;
};
`;
  const obfuscated = await obfuscate213(source, {
    ...baseline,
    deadCode: true,
  });

  expect(obfuscated).toMatch(/__p_[A-Za-z0-9]{4}_dead_\d+/);
  expect(obfuscated).toMatch(/__p_[A-Za-z0-9]{4}_dummyFunction/);

  const result = await decompile(obfuscated);

  expect(result.report.transforms.deadCode).toBeGreaterThanOrEqual(0.8);
  expect(result.safeCode).not.toContain("_dead_");
  expect(result.cleanCode).not.toContain("_dead_");
  expect(result.safeCode).not.toContain("_dummyFunction");
  expect(result.cleanCode).not.toContain("_dummyFunction");
  expect(result.cleanCode).toContain("doubled");
  expect(() => parseJavaScript(result.safeCode)).not.toThrow();
});

it("preserves user-authored similarly named functions without a generated false guard", async () => {
  const source = `
function __p_ab12_dummyFunction() {}
function __p_cd34_dead_1() { return "live"; }
module.exports = __p_cd34_dead_1();
`;
  const result = await decompile(source);

  expect(result.safeCode).toContain("__p_cd34_dead_1");
  expect(result.safeCode).toContain("live");
});
