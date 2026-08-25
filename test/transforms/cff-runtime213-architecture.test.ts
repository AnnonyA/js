import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cffDir = resolve(testDir, "../../src/passes/jsconfuser/cff");

it("centralizes shared 2.1.3 CFF evaluator and tracer helpers", () => {
  const runtimePath = resolve(cffDir, "runtime213.ts");
  expect(existsSync(runtimePath)).toBe(true);

  const runtime = readFileSync(runtimePath, "utf8");
  const sharedHelpers = [
    "evaluateOuter",
    "evaluateInner",
    "decodeXor",
    "dynamicMemberPath",
    "expandRuntimeStateArray",
    "nestedStatesFromOuterTrace",
  ];

  for (const helper of sharedHelpers) {
    expect(runtime).toContain(`export function ${helper}`);
  }

  for (const file of ["body213.ts", "bodyTwice213.ts", "bodyScenario213.ts"]) {
    const source = readFileSync(resolve(cffDir, file), "utf8");
    expect(source).toContain('from "./runtime213.js"');
    for (const helper of sharedHelpers) {
      expect(source).not.toContain(`function ${helper}(`);
    }
  }
});
