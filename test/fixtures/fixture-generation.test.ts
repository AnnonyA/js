import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseJavaScript } from "../../src/parser/parse.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(testDir, "../../compat/manifest.json");

it("declares the approved static compatibility families", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  expect(manifest).toEqual({
    formatVersion: 1,
    families: {
      "babel-2.0.0": { capabilities: ["babelAst", "cff.singleState"] },
      "babel-2.0.1": { capabilities: ["babelAst", "cff.multiState"] },
      "babel-2.1": { capabilities: ["babelAst", "cff.multiState"] },
      "babel-2.1.2+": {
        capabilities: ["babelAst", "cff.stateArray", "cff.stateStringXor"],
      },
      "babel-2.1.3": {
        capabilities: [
          "babelAst",
          "cff.stateArray",
          "cff.stateStringXor",
          "cff.dynamicTransitions",
        ],
      },
    },
  });
});

it("obfuscates a parseable isolated renameVariables sample with js-confuser 2.1.3", async () => {
  const { obfuscate213 } = await import("../helpers/jsconfuser213.js");
  const output = await obfuscate213(
    "function add(a,b){return a+b}",
    { renameVariables: true },
  );

  expect(output).not.toContain("function add");
  expect(() => parseJavaScript(output)).not.toThrow();
});
