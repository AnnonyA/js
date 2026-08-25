import { expect, it } from "vitest";
import { DecompilerContext } from "../../src/core/context.js";
import {
  PassRegistry,
  type ReversePass,
} from "../../src/core/pass.js";
import { runScheduler } from "../../src/core/scheduler.js";
import { parseJavaScript } from "../../src/parser/parse.js";
import type { ResolvedDecompileOptions } from "../../src/types.js";

const OPTIONS: ResolvedDecompileOptions = {
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

function makeContext(source: string): DecompilerContext {
  return new DecompilerContext(source, "input.js", parseJavaScript(source), OPTIONS);
}

function registryOf(...passes: ReversePass[]): PassRegistry {
  const registry = new PassRegistry();
  for (const pass of passes) registry.register(pass);
  return registry;
}

it("reruns passes until the structural state stops changing", async () => {
  const ctx = makeContext("let x = 1;");
  let transformCalls = 0;
  const pass: ReversePass = {
    id: "counting",
    prerequisites: [],
    conflicts: [],
    capabilities: ["test.counted"],
    detect: () => ({ detected: true, confidence: 1, evidence: [] }),
    analyze: () => ({ changed: false }),
    transform: () => {
      transformCalls += 1;
      if (transformCalls === 1) ctx.facts.set("changed", true);
      return { changed: transformCalls === 1 };
    },
    verify: () => ({ valid: true, confidence: 1, evidence: [] }),
  };

  const result = await runScheduler(ctx, registryOf(pass));
  expect(result.rounds).toBe(2);
  expect(transformCalls).toBe(2);
  expect(result.converged).toBe(true);
});

it("skips and reports a pass with unmet prerequisites", async () => {
  const ctx = makeContext("let x = 1;");
  let transformCalls = 0;
  const pass: ReversePass = {
    id: "needs-cfg",
    prerequisites: ["cfg.ready"],
    conflicts: [],
    capabilities: [],
    detect: () => ({ detected: true, confidence: 1, evidence: [] }),
    analyze: () => ({ changed: false }),
    transform: () => {
      transformCalls += 1;
      return { changed: false };
    },
    verify: () => ({ valid: true, confidence: 1, evidence: [] }),
  };

  const result = await runScheduler(ctx, registryOf(pass));
  expect(transformCalls).toBe(0);
  expect(result.skipped).toContainEqual({
    passId: "needs-cfg",
    reason: "unmet prerequisite: cfg.ready",
  });
});
