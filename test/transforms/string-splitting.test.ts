import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

const baseline = {
  preset: false as const,
  renameLabels: false,
  renameGlobals: false,
  preserveFunctionLength: false,
};

it("recovers 2.1.3 split strings in safe and clean output", async () => {
  const original =
    "string-splitting-regression::abcdefghijklmnopqrstuvwxyz::0123456789::ABCDEFGHIJKLMNOPQRSTUVWXYZ::the-end";
  const source = `module.exports = ${JSON.stringify(original)};`;
  const obfuscated = await obfuscate213(source, {
    ...baseline,
    stringSplitting: true,
  });

  expect(obfuscated).not.toContain(JSON.stringify(original));
  expect(obfuscated).toContain("+");

  const result = await decompile(obfuscated);

  expect(result.report.transforms.stringSplitting).toBeGreaterThanOrEqual(0.8);
  expect(result.safeCode).toContain(JSON.stringify(original));
  expect(result.cleanCode).toContain(JSON.stringify(original));
});

it("does not classify mixed runtime concatenation as js-confuser string splitting", async () => {
  const source = `
const suffix = process.argv[2];
module.exports = "prefix-" + suffix + "-tail";
`;
  const result = await decompile(source);

  expect(result.report.transforms.stringSplitting).toBeLessThan(0.5);
  expect(result.safeCode).toContain("suffix");
  expect(result.safeCode).toContain("prefix-");
  expect(result.safeCode).toContain("-tail");
});
