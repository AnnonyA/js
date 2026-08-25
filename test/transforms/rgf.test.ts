import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

const rgfOptions = {
  preset: false as const,
  rgf: true,
  renameGlobals: false,
  renameLabels: false,
  preserveFunctionLength: false,
};

it("recovers a pure function from js-confuser 2.1.3 RGF without executing eval", async () => {
  const source = `
function addTwoNumbers(a, b) {
  return a + b;
}
TEST_OUTPUT = addTwoNumbers(10, 5);
`;
  const obfuscated = await obfuscate213(source, rgfOptions);

  expect(obfuscated).toContain("_rgf_eval");

  const result = await decompile(obfuscated);

  expect(result.cleanCode).not.toContain("_rgf_eval");
  expect(result.cleanCode).toMatch(/function\s+addTwoNumbers\s*\(\s*a\s*,\s*b\s*\)/);
  expect(result.cleanCode).toMatch(/return\s+a\s*\+\s*b/);
  expect(result.cleanCode).toContain("TEST_OUTPUT = addTwoNumbers(10, 5)");
  expect(result.report.transforms.rgf).toBeGreaterThanOrEqual(0.9);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("recovers an RGF function expression", async () => {
  const source = `
var addTwoNumbers = function(a, b) {
  return a + b;
};
TEST_OUTPUT = addTwoNumbers(10, 5);
`;
  const obfuscated = await obfuscate213(source, rgfOptions);
  expect(obfuscated).toContain("_rgf_eval");

  const result = await decompile(obfuscated);

  expect(result.cleanCode).not.toContain("_rgf_eval");
  expect(result.cleanCode).toMatch(/function\s*\(\s*a\s*,\s*b\s*\)/);
  expect(result.cleanCode).toMatch(/return\s+a\s*\+\s*b/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("recovers an RGF function that accesses an allowed global", async () => {
  const source = `
function floorNumber(num) {
  return Math.floor(num);
}
TEST_OUTPUT = floorNumber(1.9);
`;
  const obfuscated = await obfuscate213(source, rgfOptions);
  expect(obfuscated).toContain("_rgf_eval");

  const result = await decompile(obfuscated);

  expect(result.cleanCode).not.toContain("_rgf_eval");
  expect(result.cleanCode).toMatch(/function\s+floorNumber\s*\(\s*num\s*\)/);
  expect(result.cleanCode).toMatch(/Math(?:\.floor|\["floor"\])\(num\)/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("does not invent RGF recovery when js-confuser skips an outside closure dependency", async () => {
  const source = `
var _Math = Math;
function floorNumber(num) {
  return _Math.floor(num);
}
TEST_OUTPUT = floorNumber(1.9);
`;
  const obfuscated = await obfuscate213(source, rgfOptions);
  expect(obfuscated).not.toContain("_rgf_eval");

  const result = await decompile(obfuscated);

  expect(result.report.transforms.rgf).toBeLessThan(0.5);
  expect(result.cleanCode).toMatch(/_Math(?:\.floor|\["floor"\])\(num\)/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("recovers RGF after statically unpacking a Pack wrapper", async () => {
  const source = `
function addTwoNumbers(a, b) {
  return a + b;
}
TEST_OUTPUT = addTwoNumbers(10, 5);
`;
  const obfuscated = await obfuscate213(source, {
    ...rgfOptions,
    pack: true,
  });

  expect(obfuscated).toMatch(/\bFunction\s*\(/);
  expect(obfuscated).toContain("_rgf_eval");

  const result = await decompile(obfuscated);

  expect(result.cleanCode).not.toMatch(/\bFunction\s*\(\s*["']/);
  expect(result.cleanCode).not.toContain("_rgf_eval");
  expect(result.cleanCode).toMatch(/function\s+addTwoNumbers\s*\(\s*a\s*,\s*b\s*\)/);
  expect(result.cleanCode).toMatch(/return\s+a\s*\+\s*b/);
  expect(result.cleanCode).toContain("TEST_OUTPUT = addTwoNumbers(10, 5)");
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});
