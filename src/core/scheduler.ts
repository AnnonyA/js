import { createHash } from "node:crypto";
import { generateJavaScript } from "../parser/generate.js";
import type { DecompilerContext } from "./context.js";
import {
  clampConfidence,
  type PassRegistry,
  type ReversePass,
} from "./pass.js";

export interface SchedulerSkip {
  passId: string;
  reason: string;
}

export interface SchedulerResult {
  rounds: number;
  converged: boolean;
  skipped: SchedulerSkip[];
}

function stateHash(ctx: DecompilerContext): string {
  const state = JSON.stringify({
    safeCode: generateJavaScript(ctx.safeAst),
    cleanCode: generateJavaScript(ctx.cleanAst),
    factCount: ctx.facts.size,
    capabilityCount: ctx.capabilities.size,
  });
  return createHash("sha256").update(state).digest("hex");
}

function orderPasses(passes: ReversePass[]): ReversePass[] {
  const index = new Map(passes.map((pass, position) => [pass.id, position]));
  const providers = new Map<string, ReversePass[]>();
  for (const pass of passes) {
    for (const capability of pass.capabilities) {
      const existing = providers.get(capability) ?? [];
      existing.push(pass);
      providers.set(capability, existing);
    }
  }

  const dependencies = new Map<ReversePass, Set<ReversePass>>();
  for (const pass of passes) {
    const deps = new Set<ReversePass>();
    for (const prerequisite of pass.prerequisites) {
      for (const provider of providers.get(prerequisite) ?? []) {
        if (provider !== pass) deps.add(provider);
      }
    }
    dependencies.set(pass, deps);
  }

  const ordered: ReversePass[] = [];
  const remaining = new Set(passes);
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((pass) =>
        [...(dependencies.get(pass) ?? [])].every((dep) => !remaining.has(dep)),
      )
      .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));

    if (ready.length === 0) {
      ordered.push(
        ...[...remaining].sort(
          (a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0),
        ),
      );
      break;
    }

    for (const pass of ready) {
      remaining.delete(pass);
      ordered.push(pass);
    }
  }
  return ordered;
}

function recordPassError(
  ctx: DecompilerContext,
  passId: string,
  stage: "detect" | "analyze" | "transform" | "verify",
  error: unknown,
): void {
  const code = stage === "detect" ? "PASS_DETECTION_FAILED" : "PASS_TRANSFORM_FAILED";
  const diagnostic = ctx.diagnostics.warn(
    code,
    `${passId} failed during ${stage}`,
    {
      passId,
      cause: error instanceof Error ? error.message : String(error),
    },
  );
  ctx.report.warnings.push(diagnostic);
}

function recordTransformDetection(
  ctx: DecompilerContext,
  pass: ReversePass,
  confidence: number,
): void {
  if (!pass.transformId) return;
  const previous = ctx.report.transforms[pass.transformId] ?? 0;
  ctx.report.transforms[pass.transformId] = Math.max(previous, confidence);
}

export async function runScheduler(
  ctx: DecompilerContext,
  registry: PassRegistry,
): Promise<SchedulerResult> {
  const passes = orderPasses(registry.all());
  const skipped: SchedulerSkip[] = [];
  let previousHash = stateHash(ctx);

  for (let round = 1; round <= ctx.options.limits.maxRounds; round += 1) {
    ctx.round = round;

    for (const pass of passes) {
      const unmet = pass.prerequisites.find(
        (prerequisite) => !ctx.capabilities.has(prerequisite),
      );
      if (unmet) {
        const skip = {
          passId: pass.id,
          reason: `unmet prerequisite: ${unmet}`,
        };
        if (!skipped.some((item) => item.passId === skip.passId && item.reason === skip.reason)) {
          skipped.push(skip);
        }
        continue;
      }

      const conflict = pass.conflicts.find((item) => ctx.capabilities.has(item));
      if (conflict) {
        const skip = { passId: pass.id, reason: `conflict: ${conflict}` };
        if (!skipped.some((item) => item.passId === skip.passId && item.reason === skip.reason)) {
          skipped.push(skip);
        }
        continue;
      }

      try {
        const detection = await pass.detect(ctx);
        detection.confidence = clampConfidence(detection.confidence);
        if (!detection.detected) continue;
        recordTransformDetection(ctx, pass, detection.confidence);
      } catch (error) {
        recordPassError(ctx, pass.id, "detect", error);
        continue;
      }

      try {
        const analysis = await pass.analyze(ctx);
        if (analysis.facts) {
          for (const [key, value] of Object.entries(analysis.facts)) {
            ctx.facts.set(key, value);
          }
        }
      } catch (error) {
        recordPassError(ctx, pass.id, "analyze", error);
        continue;
      }

      let result;
      try {
        result = await pass.transform(ctx);
      } catch (error) {
        recordPassError(ctx, pass.id, "transform", error);
        continue;
      }

      try {
        const verification = await pass.verify(ctx, result);
        verification.confidence = clampConfidence(verification.confidence);
        if (!verification.valid) {
          recordPassError(
            ctx,
            pass.id,
            "verify",
            new Error("verification rejected transformed result"),
          );
          continue;
        }
        for (const capability of pass.capabilities) {
          ctx.capabilities.add(capability);
        }
      } catch (error) {
        recordPassError(ctx, pass.id, "verify", error);
      }
    }

    const currentHash = stateHash(ctx);
    if (currentHash === previousHash) {
      return { rounds: round, converged: true, skipped };
    }
    previousHash = currentHash;
  }

  return {
    rounds: ctx.options.limits.maxRounds,
    converged: false,
    skipped,
  };
}
