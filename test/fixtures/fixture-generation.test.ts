import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

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
