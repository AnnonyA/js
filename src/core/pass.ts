import type { TransformId } from "../fingerprint/transforms.js";
import type { DecompilerContext } from "./context.js";

export interface DetectionResult {
  detected: boolean;
  confidence: number;
  evidence: string[];
}

export interface AnalysisResult {
  changed: boolean;
  facts?: Record<string, unknown>;
}

export interface PassResult {
  changed: boolean;
  actions?: string[];
}

export interface VerificationResult {
  valid: boolean;
  confidence: number;
  evidence: string[];
}

export interface ReversePass {
  id: string;
  transformId?: TransformId;
  prerequisites: string[];
  conflicts: string[];
  capabilities: string[];
  detect(
    ctx: DecompilerContext,
  ): DetectionResult | Promise<DetectionResult>;
  analyze(
    ctx: DecompilerContext,
  ): AnalysisResult | Promise<AnalysisResult>;
  transform(ctx: DecompilerContext): PassResult | Promise<PassResult>;
  verify(
    ctx: DecompilerContext,
    result: PassResult,
  ): VerificationResult | Promise<VerificationResult>;
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export class PassRegistry {
  readonly #passes = new Map<string, ReversePass>();

  register(pass: ReversePass): void {
    if (this.#passes.has(pass.id)) {
      throw new Error(`Duplicate pass id: ${pass.id}`);
    }
    this.#passes.set(pass.id, pass);
  }

  all(): ReversePass[] {
    return [...this.#passes.values()];
  }

  byCapability(capability: string): ReversePass[] {
    return this.all().filter((pass) => pass.capabilities.includes(capability));
  }
}
