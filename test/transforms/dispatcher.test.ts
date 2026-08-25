import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { parseJavaScript } from "../../src/parser/parse.js";

const testDir = dirname(fileURLToPath(import.meta.url));

it("reconstructs directly recoverable 2.1.3 dispatcher functions and calls", async () => {
  const obfuscated = readFileSync(
    resolve(testDir, "../fixtures/2.1.3/dispatcher/obfuscated.js"),
    "utf8",
  );

  const result = await decompile(obfuscated);

  expect(result.report.transforms.dispatcher).toBeGreaterThanOrEqual(0.8);
  expect(result.cleanCode).toMatch(/function add3\(a, b, c\)/);
  expect(result.cleanCode).toMatch(/function twice\(x\)/);
  expect(result.cleanCode).toMatch(/function scenario\(value\)/);
  expect(result.cleanCode).toContain("add3(x, x, 0)");
  expect(result.cleanCode).toContain("twice(value)");
  expect(result.cleanCode).toMatch(/module\["exports"\]\s*=\s*\{/);
  expect(result.cleanCode).toMatch(/\["add3"\]: add3/);
  expect(result.cleanCode).toMatch(/\["twice"\]: twice/);
  expect(result.cleanCode).toMatch(/\["scenario"\]: scenario/);
  expect(result.cleanCode).not.toMatch(/_dispatcher_\d+/);
  expect(result.cleanCode).not.toMatch(/_payload/);
  expect(result.cleanCode).not.toMatch(/_cache/);
  expect(() => parseJavaScript(result.cleanCode)).not.toThrow();
});

it("does not rewrite an unrelated user dispatcher", async () => {
  const source = `
function dispatcher(name) {
  const fns = { add: () => 1 };
  return fns[name]();
}
module.exports = dispatcher("add");
`;
  const result = await decompile(source);

  expect(result.cleanCode).toContain("function dispatcher(name)");
  expect(result.cleanCode).toContain("dispatcher(\"add\")");
});
