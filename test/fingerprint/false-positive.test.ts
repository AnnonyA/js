import { expect, it } from "vitest";
import { DecompilerContext } from "../../src/core/context.js";
import { resolveOptions } from "../../src/core/decompiler.js";
import { fingerprintProgram } from "../../src/fingerprint/detector.js";
import { parseJavaScript } from "../../src/parser/parse.js";

it("does not mistake a legitimate state machine for js-confuser CFF", () => {
  const source = `
let state = 0;
while (state < 3) {
  switch (state) {
    case 0: console.log("a"); state = 1; break;
    case 1: console.log("b"); state = 2; break;
    default: state = 3;
  }
}
`;
  const ast = parseJavaScript(source);
  const ctx = new DecompilerContext(
    source,
    "state-machine.js",
    ast,
    resolveOptions(),
  );

  const result = fingerprintProgram(ctx);
  expect(result.jsConfuserConfidence).toBeLessThan(0.5);
  expect(result.family).toBeNull();
});
