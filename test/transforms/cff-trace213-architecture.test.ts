import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cffDir = resolve(testDir, "../../src/passes/jsconfuser/cff");

it("centralizes the 2.1.3 A-to-B-to-C nested-state tracer", () => {
  const runtime = readFileSync(resolve(cffDir, "runtime213.ts"), "utf8");
  for (const helper of [
    "callPath",
    "nestedStatesFromOuterTrace",
    "innerSwitchPath",
    "tailExpression",
  ]) {
    expect(runtime).toContain(`export function ${helper}`);
  }
  expect(runtime).toContain("export interface NestedStateTrace");

  for (const file of ["body213.ts", "bodyTwice213.ts", "bodyScenario213.ts"]) {
    const source = readFileSync(resolve(cffDir, file), "utf8");
    expect(source).not.toContain("interface NestedStateTrace");
    expect(source).not.toContain("function recursiveHelperStates(");
    expect(source).not.toContain("function nestedStatesFromOuterTrace(");
    expect(source).not.toContain("function innerSwitchPath(");
    expect(source).not.toContain("function tailExpression(");
  }

  expect(readFileSync(resolve(cffDir, "body213.ts"), "utf8")).not.toContain(
    "function callTargetPath(",
  );
  for (const file of ["bodyTwice213.ts", "bodyScenario213.ts"]) {
    expect(readFileSync(resolve(cffDir, file), "utf8")).not.toContain("function callPath(");
  }
});
