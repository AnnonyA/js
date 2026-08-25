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

async function obfuscateWithOpaquePredicate(source: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const obfuscated = await obfuscate213(source, {
      ...baseline,
      opaquePredicates: true,
    });
    if (/_dummyFunction/.test(obfuscated) && /\sin\s/.test(obfuscated)) {
      return obfuscated;
    }
  }
  throw new Error("js-confuser 2.1.3 did not emit an opaque predicate in 8 attempts");
}

it("removes proven 2.1.3 opaque predicates and their dummy function", async () => {
  const source = `
var test = false;
if (test) {
  module.exports = "Incorrect Value";
} else {
  module.exports = "Correct Value";
}
`;
  const obfuscated = await obfuscateWithOpaquePredicate(source);
  expect(obfuscated).toMatch(/__p_[A-Za-z0-9]{4}_dummyFunction/);

  const result = await decompile(obfuscated);

  expect(result.report.transforms.opaquePredicates).toBeGreaterThanOrEqual(0.8);
  expect(result.safeCode).not.toContain("_dummyFunction");
  expect(result.cleanCode).not.toContain("_dummyFunction");
  expect(result.safeCode).not.toMatch(/\sin\s+__p_/);
  expect(result.cleanCode).not.toMatch(/\sin\s+__p_/);
  expect(result.cleanCode).toContain("Incorrect Value");
  expect(result.cleanCode).toContain("Correct Value");
  expect(() => parseJavaScript(result.safeCode)).not.toThrow();
});

it("does not rewrite a user-authored membership guard around an empty function", async () => {
  const source = `
function guard() {}
const enabled = process.argv.length > 2;
module.exports = !("missing" in guard) && enabled;
`;
  const result = await decompile(source);

  expect(result.report.transforms.opaquePredicates).toBeLessThan(0.5);
  expect(result.safeCode).toContain("missing");
  expect(result.safeCode).toContain("guard");
  expect(result.safeCode).toContain("enabled");
});
