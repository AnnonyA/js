import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { DecompilerContext } from "../../src/core/context.js";
import { createDecompiler, resolveOptions } from "../../src/core/decompiler.js";
import {
  detectTransforms,
  TRANSFORM_IDS,
} from "../../src/fingerprint/transforms.js";
import { parseJavaScript } from "../../src/parser/parse.js";

function fixture(name: string): string {
  return readFileSync(
    resolve(`test/fixtures/2.1.3/${name}/obfuscated.js`),
    "utf8",
  );
}

function detections(name: string) {
  const source = fixture(name);
  const ctx = new DecompilerContext(
    source,
    `${name}.js`,
    parseJavaScript(source),
    resolveOptions(),
  );
  return detectTransforms(ctx);
}

it("detects the isolated 2.1.3 transform fixtures", () => {
  const expected = [
    ["stringConcealing", "stringConcealing"],
    ["globalConcealing", "globalConcealing"],
    ["variableMasking", "variableMasking"],
    ["dispatcher", "dispatcher"],
    ["controlFlowFlattening", "controlFlowFlattening"],
    ["opaquePredicates", "opaquePredicates"],
    ["deadCode", "deadCode"],
    ["renameVariables", "renameVariables"],
  ] as const;

  for (const [fixtureName, transform] of expected) {
    expect(
      detections(fixtureName)[transform].confidence,
      `${fixtureName} should detect ${transform}`,
    ).toBeGreaterThanOrEqual(0.8);
  }
});

it("returns every transform group and keeps unrelated scores low", () => {
  const masked = detections("variableMasking");
  expect(Object.keys(masked).sort()).toEqual([...TRANSFORM_IDS].sort());
  expect(masked.dispatcher.confidence).toBeLessThan(0.5);
  expect(masked.controlFlowFlattening.confidence).toBeLessThan(0.5);

  const strings = detections("stringConcealing");
  expect(strings.variableMasking.confidence).toBeLessThan(0.5);
  expect(strings.controlFlowFlattening.confidence).toBeLessThan(0.5);
});

it("writes fingerprint and transform detections into the session report", async () => {
  const session = createDecompiler();
  await session.parse(fixture("controlFlowFlattening"), "cff.js");
  await session.analyze();

  expect(session.context.report.fingerprint.jsConfuserConfidence).toBeGreaterThanOrEqual(0.8);
  expect(session.context.report.transforms.controlFlowFlattening).toBeGreaterThanOrEqual(0.8);
});
