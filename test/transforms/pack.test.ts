import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

const packOptions = {
  preset: false as const,
  pack: true,
  renameGlobals: false,
  renameLabels: false,
  preserveFunctionLength: false,
};

it("statically unpacks js-confuser 2.1.3 Pack and restores a mapped global", async () => {
  const source = `TEST_OUTPUT = "Correct Value";`;
  const obfuscated = await obfuscate213(source, packOptions);

  expect(obfuscated.startsWith("Function")).toBe(true);

  const result = await decompile(obfuscated);

  expect(result.report.transforms.pack).toBeGreaterThanOrEqual(0.9);
  expect(result.cleanCode).toContain("TEST_OUTPUT");
  expect(result.cleanCode).toContain("Correct Value");
  expect(result.cleanCode).not.toMatch(/\bFunction\s*\(\s*["']/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("restores Pack typeof mappings without evaluating the missing global", async () => {
  const source = `TEST_OUTPUT = typeof MAYBE_MISSING;`;
  const obfuscated = await obfuscate213(source, packOptions);

  const result = await decompile(obfuscated);

  expect(result.cleanCode).toContain("typeof MAYBE_MISSING");
  expect(result.cleanCode).not.toMatch(/\bFunction\s*\(\s*["']/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("preserves imports that js-confuser leaves outside the Pack payload", async () => {
  const source = `
import { createHash } from "crypto";
TEST_OUTPUT = createHash("sha256").update("value").digest("hex");
`;
  const obfuscated = await obfuscate213(source, packOptions);
  expect(obfuscated.startsWith("import")).toBe(true);

  const result = await decompile(obfuscated);

  expect(result.cleanCode).toContain('from "crypto"');
  expect(result.cleanCode).toContain("createHash");
  expect(result.cleanCode).toContain("TEST_OUTPUT");
  expect(result.cleanCode).not.toMatch(/\bFunction\s*\(\s*["']/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("does not unpack an unrelated Function constructor call", async () => {
  const source = `Function("scope", "return scope.value;")({ value: 1 });`;
  const result = await decompile(source);

  expect(result.cleanCode).toMatch(/\bFunction\s*\(/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});
