import { expect, it } from "vitest";
import { parseJavaScript } from "../../src/parser/parse.js";
import { generateJavaScript } from "../../src/parser/generate.js";

it("parses and regenerates modern JavaScript", () => {
  const ast = parseJavaScript("const f = (x = 1) => x?.toString();");
  const out = generateJavaScript(ast);
  expect(out).toContain("const f");
  expect(() => parseJavaScript(out)).not.toThrow();
});
