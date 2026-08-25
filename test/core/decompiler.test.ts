import { expect, it } from "vitest";
import { decompile, resolveOptions } from "../../src/index.js";

it("returns separate safe and clean outputs plus report", async () => {
  const result = await decompile("const answer = 40 + 2;");

  expect(result.safeCode).toContain("answer");
  expect(result.cleanCode).toContain("answer");
  expect(result.report.formatVersion).toBe(1);
  expect(result.ast.safe).not.toBe(result.ast.clean);
});

it("resolves the Phase 1 option defaults", () => {
  const options = resolveOptions();

  expect(options).toMatchObject({
    target: "auto",
    dynamic: "auto",
    confidence: { safeThreshold: 0.95, cleanThreshold: 0.8 },
    limits: {
      timeoutMs: 1000,
      memoryMb: 128,
      maxExecutions: 16,
      maxGeneratedCodeDepth: 4,
      maxCfgNodes: 10000,
      maxSymbolicBranches: 2048,
      maxRounds: 12,
    },
    tracing: { enabled: false, level: 0 },
    output: { safe: true, clean: true, report: true },
  });
});
