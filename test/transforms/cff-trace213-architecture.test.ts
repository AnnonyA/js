import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cffDir = resolve(testDir, "../../src/passes/jsconfuser/cff");

it("keeps the 2.1.3 nested-state tracer centralized", () => {
  const runtime = readFileSync(resolve(cffDir, "runtime213.ts"), "utf8");
  const wrapperRuntime = readFileSync(resolve(cffDir, "wrapperRuntime213.ts"), "utf8");

  // Low-level state execution stays in runtime213; wrapper discovery/tracing stays one layer above it.
  expect(runtime).toContain("export function traceInnerSwitchCases");
  for (const helper of [
    "callPath",
    "traceNestedStateInvocation",
    "innerSwitchPath",
    "tailExpression",
  ]) {
    expect(wrapperRuntime).toContain(`export function ${helper}`);
  }
  expect(wrapperRuntime).toContain("export interface NestedStateTrace");

  for (const file of ["body213.ts", "bodyTwice213.ts", "bodyScenario213.ts"]) {
    const source = readFileSync(resolve(cffDir, file), "utf8");
    expect(source).not.toContain("interface NestedStateTrace");
    expect(source).not.toContain("function recursiveHelperStates(");
    expect(source).not.toContain("function traceNestedStateInvocation(");
    expect(source).not.toContain("function innerSwitchPath(");
    expect(source).not.toContain("function tailExpression(");
  }
});
