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

it("restores 2.1.3 concealed global identifiers and removes their resolver", async () => {
  const source = `
module.exports = function globals(value) {
  return Math.max(value, 10) + JSON.parse('{"n":2}').n;
};
`;
  const obfuscated = await obfuscate213(source, {
    ...baseline,
    globalConcealing: true,
  });
  expect(obfuscated).toMatch(/_getGlobal/);

  const result = await decompile(obfuscated);
  const cleanAst = JSON.stringify(result.ast.clean);

  expect(result.report.transforms.globalConcealing).toBeGreaterThanOrEqual(0.8);
  expect(cleanAst).toContain('"name":"Math"');
  expect(cleanAst).toContain('"name":"JSON"');
  expect(result.cleanCode).not.toMatch(/_getGlobal/);
  expect(result.cleanCode).not.toMatch(/_globalVar/);
  expect(() => parseJavaScript(result.safeCode)).not.toThrow();
});

it("reconstructs a high-confidence 2.1.3 extracted object in clean output", async () => {
  const source = `
module.exports = function extracted() {
  const config = {
    base: 10,
    label: "score",
    add: function(value) { return value + 1; }
  };
  return [config.base, config.label, config.add(4)];
};
`;
  const obfuscated = await obfuscate213(source, {
    ...baseline,
    objectExtraction: true,
  });
  expect(obfuscated).toMatch(/__p_[A-Za-z0-9]{4}_config_/);

  const result = await decompile(obfuscated);

  expect(result.report.transforms.objectExtraction).toBeGreaterThanOrEqual(0.8);
  expect(result.cleanCode).toMatch(/(?:const|let) config\s*=\s*\{/);
  expect(result.cleanCode).toContain("base: 10");
  expect(result.cleanCode).toContain('label: "score"');
  expect(result.cleanCode).toContain("config.base");
  expect(result.cleanCode).toContain("config.label");
  expect(result.cleanCode).toContain("config.add(4)");
  expect(result.cleanCode).not.toMatch(/__p_[A-Za-z0-9]{4}_config_/);
  expect(() => parseJavaScript(result.safeCode)).not.toThrow();
});
