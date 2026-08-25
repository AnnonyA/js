import { expect, it } from "vitest";
import { DecompilerContext } from "../../src/core/context.js";
import { runAstTransaction } from "../../src/core/transaction.js";
import { generateJavaScript } from "../../src/parser/generate.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import type { ResolvedDecompileOptions } from "../../src/types.js";

const TEST_OPTIONS: ResolvedDecompileOptions = {
  target: "auto",
  dynamic: "auto",
  output: { safe: true, clean: true, report: true },
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
};

function makeTestContext(source: string): DecompilerContext {
  return new DecompilerContext(
    source,
    "input.js",
    parseJavaScript(source),
    TEST_OPTIONS,
  );
}

const meta = {
  passId: "test.invalid",
  action: "corrupt-program",
  confidence: 1,
  evidence: ["unit-test"],
};

it("rolls back an invalid AST mutation", () => {
  const ctx = makeTestContext("const x = 1;");
  const before = generateJavaScript(ctx.safeAst);
  const result = runAstTransaction(ctx, "safe", meta, (ast) => {
    (ast.program.body as unknown as unknown[]).push({ type: "NoSuchNode" });
  });

  expect(result.committed).toBe(false);
  expect(generateJavaScript(ctx.safeAst)).toBe(before);
  expect(ctx.report.passes.at(-1)?.rolledBack).toBe(true);
  expect(ctx.report.warnings.at(-1)?.code).toBe("PASS_TRANSFORM_FAILED");
});
