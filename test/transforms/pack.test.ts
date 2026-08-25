import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

it("statically unpacks js-confuser 2.1.3 Pack and restores a mapped global", async () => {
  const source = `TEST_OUTPUT = "Correct Value";`;
  const obfuscated = await obfuscate213(source, {
    preset: false,
    pack: true,
    renameGlobals: false,
    renameLabels: false,
    preserveFunctionLength: false,
  });

  expect(obfuscated.startsWith("Function")).toBe(true);

  const result = await decompile(obfuscated);

  expect(result.cleanCode).toContain("TEST_OUTPUT");
  expect(result.cleanCode).toContain("Correct Value");
  expect(result.cleanCode).not.toMatch(/\bFunction\s*\(\s*["']/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});
