import { cloneNode } from "@babel/types";
import { analyzeBindings } from "../analysis/bindings/index.js";
import { fingerprintProgram } from "../fingerprint/detector.js";
import { detectTransforms } from "../fingerprint/transforms.js";
import { generateJavaScript } from "../parser/generate.js";
import { normalizeSyntax } from "../parser/normalize.js";
import { parseJavaScript } from "../parser/parse.js";
import { validateSyntax } from "../validation/syntax.js";
import type {
  DecompileOptions,
  DecompileResult,
  ResolvedDecompileOptions,
} from "../types.js";
import { DecompilerContext } from "./context.js";
import { PassRegistry } from "./pass.js";
import { runScheduler } from "./scheduler.js";

const DEFAULT_OPTIONS: ResolvedDecompileOptions = {
  target: "auto",
  dynamic: "auto",
  output: {
    safe: true,
    clean: true,
    report: true,
  },
  confidence: {
    safeThreshold: 0.95,
    cleanThreshold: 0.8,
  },
  limits: {
    timeoutMs: 1000,
    memoryMb: 128,
    maxExecutions: 16,
    maxGeneratedCodeDepth: 4,
    maxCfgNodes: 10000,
    maxSymbolicBranches: 2048,
    maxRounds: 12,
  },
  tracing: {
    enabled: false,
    level: 0,
  },
};

export function resolveOptions(
  options: DecompileOptions = {},
): ResolvedDecompileOptions {
  return {
    target: options.target ?? DEFAULT_OPTIONS.target,
    dynamic: options.dynamic ?? DEFAULT_OPTIONS.dynamic,
    ...(options.config === undefined ? {} : { config: options.config }),
    output: {
      ...DEFAULT_OPTIONS.output,
      ...options.output,
    },
    confidence: {
      ...DEFAULT_OPTIONS.confidence,
      ...options.confidence,
    },
    limits: {
      ...DEFAULT_OPTIONS.limits,
      ...options.limits,
    },
    tracing: {
      ...DEFAULT_OPTIONS.tracing,
      ...options.tracing,
    },
  };
}

export class DecompilerSession {
  readonly options: ResolvedDecompileOptions;
  readonly registry = new PassRegistry();
  private contextValue: DecompilerContext | null = null;

  constructor(options: DecompileOptions = {}) {
    this.options = resolveOptions(options);
  }

  get context(): DecompilerContext {
    if (!this.contextValue) {
      throw new Error("DecompilerSession.parse() must be called first");
    }
    return this.contextValue;
  }

  async parse(source: string, filename = "input.js"): Promise<void> {
    const inputAst = normalizeSyntax(parseJavaScript(source, filename));
    this.contextValue = new DecompilerContext(
      source,
      filename,
      inputAst,
      this.options,
    );
  }

  async analyze(): Promise<void> {
    const ctx = this.context;
    const fingerprint = fingerprintProgram(ctx);
    const transforms = detectTransforms(ctx);

    ctx.facts.set("fingerprint", fingerprint);
    ctx.facts.set("analysis.transforms", transforms);
    ctx.facts.set("analysis.bindings", analyzeBindings(ctx.inputAst));

    ctx.report.fingerprint = {
      jsConfuserConfidence: fingerprint.jsConfuserConfidence,
      family: fingerprint.family,
      versionCandidates: { ...fingerprint.versionCandidates },
    };
    ctx.report.transforms = Object.fromEntries(
      Object.entries(transforms).map(([id, result]) => [id, result.confidence]),
    );
  }

  async reverse(): Promise<void> {
    const ctx = this.context;
    const schedulerResult = await runScheduler(ctx, this.registry);
    ctx.facts.set("scheduler.result", schedulerResult);
  }

  async validate(): Promise<void> {
    const ctx = this.context;
    const safe = validateSyntax(ctx.safeAst);
    const clean = validateSyntax(ctx.cleanAst);
    ctx.report.validation.safe.syntax = safe.valid;
    ctx.report.validation.clean.syntax = clean.valid;
  }

  result(): DecompileResult {
    const ctx = this.context;
    const safeAst = cloneNode(ctx.safeAst, true);
    const cleanAst = cloneNode(ctx.cleanAst, true);

    return {
      safeCode: generateJavaScript(safeAst),
      cleanCode: generateJavaScript(cleanAst),
      ast: {
        safe: safeAst,
        clean: cleanAst,
      },
      report: ctx.report,
    };
  }
}

export function createDecompiler(
  options: DecompileOptions = {},
): DecompilerSession {
  return new DecompilerSession(options);
}

export async function decompile(
  source: string,
  options: DecompileOptions = {},
): Promise<DecompileResult> {
  const session = createDecompiler(options);
  await session.parse(source);
  await session.analyze();
  await session.reverse();
  await session.validate();
  return session.result();
}
