import { existsSync, readFileSync, rmSync } from "node:fs";
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

it("materializes a self-contained 2.1.3 fixture", async () => {
  const { generate213Fixture } = await import("../helpers/jsconfuser213.js");
  const name = `_smoke-renameVariables-${process.pid}-${Date.now()}`;
  const paths = await generate213Fixture(
    name,
    "function add(a,b){return a+b}",
    { renameVariables: true },
  );

  try {
    expect(existsSync(paths.sourcePath)).toBe(true);
    expect(existsSync(paths.optionsPath)).toBe(true);
    expect(existsSync(paths.obfuscatedPath)).toBe(true);
    expect(existsSync(paths.expectedPath)).toBe(true);

    expect(readFileSync(paths.sourcePath, "utf8")).toContain("function add");
    expect(JSON.parse(readFileSync(paths.optionsPath, "utf8"))).toMatchObject({
      target: "node",
      compact: true,
      renameVariables: true,
    });

    const obfuscated = readFileSync(paths.obfuscatedPath, "utf8");
    expect(obfuscated).not.toContain("function add");
    expect(() => parseJavaScript(obfuscated)).not.toThrow();
    expect(JSON.parse(readFileSync(paths.expectedPath, "utf8"))).toEqual({
      parseable: true,
    });
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

it("stores the nine approved isolated 2.1.3 golden fixtures", () => {
  const scriptPath = resolve(testDir, "../../scripts/generate-213-fixtures.ts");
  const sourcePath = resolve(testDir, "2.1.3/sources/basic.js");
  expect(existsSync(scriptPath)).toBe(true);
  expect(existsSync(sourcePath)).toBe(true);

  const fixtureOptions = {
    renameVariables: { renameVariables: true, renameGlobals: true },
    calculator: { calculator: true, renameGlobals: false },
    stringConcealing: { stringConcealing: true, renameGlobals: false },
    globalConcealing: { globalConcealing: true, renameGlobals: false },
    variableMasking: { variableMasking: true, renameGlobals: false },
    dispatcher: { dispatcher: true, renameGlobals: false },
    controlFlowFlattening: {
      controlFlowFlattening: true,
      renameGlobals: false,
    },
    opaquePredicates: { opaquePredicates: true, renameGlobals: false },
    deadCode: { deadCode: true, renameGlobals: false },
  } as const;

  for (const [name, primaryOptions] of Object.entries(fixtureOptions)) {
    const directory = resolve(testDir, "2.1.3", name);
    const optionsPath = resolve(directory, "options.json");
    const obfuscatedPath = resolve(directory, "obfuscated.js");
    const expectedPath = resolve(directory, "expected.json");
    const fixtureSourcePath = resolve(directory, "source.js");

    expect(existsSync(fixtureSourcePath), `${name}: source.js`).toBe(true);
    expect(existsSync(optionsPath), `${name}: options.json`).toBe(true);
    expect(existsSync(obfuscatedPath), `${name}: obfuscated.js`).toBe(true);
    expect(existsSync(expectedPath), `${name}: expected.json`).toBe(true);

    expect(JSON.parse(readFileSync(optionsPath, "utf8"))).toMatchObject({
      target: "node",
      compact: true,
      renameLabels: false,
      ...primaryOptions,
    });
    expect(() => parseJavaScript(readFileSync(obfuscatedPath, "utf8"))).not.toThrow();
    expect(JSON.parse(readFileSync(expectedPath, "utf8"))).toEqual({
      parseable: true,
    });
  }
});
