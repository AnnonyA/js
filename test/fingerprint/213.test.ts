import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { DecompilerContext } from "../../src/core/context.js";
import { resolveOptions } from "../../src/core/decompiler.js";
import { fingerprintProgram } from "../../src/fingerprint/detector.js";
import { parseJavaScript } from "../../src/parser/parse.js";

function contextFor(source: string, config?: Record<string, unknown>) {
  return new DecompilerContext(
    source,
    "fixture.js",
    parseJavaScript(source),
    resolveOptions(config ? { config } : {}),
  );
}

it("strongly identifies the js-confuser 2.1.3 CFF fixture", () => {
  const source = readFileSync(
    resolve("test/fixtures/2.1.3/controlFlowFlattening/obfuscated.js"),
    "utf8",
  );
  const result = fingerprintProgram(contextFor(source));

  expect(result.jsConfuserConfidence).toBeGreaterThanOrEqual(0.8);
  expect(["babel-2.1.3", "babel-2.1.2+"]).toContain(result.family);
  expect(result.versionCandidates["2.1.3"] ?? 0).toBeGreaterThan(0);
  expect(result.evidence.filter((item) => item.matched).length).toBeGreaterThanOrEqual(3);
});

it("treats original config as weak evidence rather than proof", () => {
  const source = "function add(a, b) { return a + b; }";
  const result = fingerprintProgram(
    contextFor(source, { controlFlowFlattening: true }),
  );

  expect(result.jsConfuserConfidence).toBeLessThan(0.5);
  expect(
    result.evidence.some(
      (item) => item.id === "config.controlFlowFlattening" && item.matched,
    ),
  ).toBe(true);
});
