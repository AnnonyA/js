import type * as t from "@babel/types";
import type { Diagnostic } from "./core/diagnostics.js";
import type { PassActionRecord } from "./core/provenance.js";

export type Target = "auto" | "node" | "browser";
export type DynamicMode = "off" | "auto" | "aggressive";
export type JsConfuserOptions = Record<string, unknown>;

export interface DecompileOptions {
  target?: Target;
  dynamic?: DynamicMode;
  config?: JsConfuserOptions;
  output?: {
    safe?: boolean;
    clean?: boolean;
    report?: boolean;
  };
  confidence?: {
    safeThreshold?: number;
    cleanThreshold?: number;
  };
  limits?: {
    timeoutMs?: number;
    memoryMb?: number;
    maxExecutions?: number;
    maxGeneratedCodeDepth?: number;
    maxCfgNodes?: number;
    maxSymbolicBranches?: number;
    maxRounds?: number;
  };
  tracing?: {
    enabled?: boolean;
    level?: 0 | 1 | 2 | 3;
  };
}

export interface ResolvedDecompileOptions {
  target: Target;
  dynamic: DynamicMode;
  config?: JsConfuserOptions;
  output: {
    safe: boolean;
    clean: boolean;
    report: boolean;
  };
  confidence: {
    safeThreshold: number;
    cleanThreshold: number;
  };
  limits: {
    timeoutMs: number;
    memoryMb: number;
    maxExecutions: number;
    maxGeneratedCodeDepth: number;
    maxCfgNodes: number;
    maxSymbolicBranches: number;
    maxRounds: number;
  };
  tracing: {
    enabled: boolean;
    level: 0 | 1 | 2 | 3;
  };
}

export type NamingOrigin = "recovered" | "inferred" | "synthetic" | "unknown";

export interface NamingRecord {
  old: string;
  new: string;
  origin: NamingOrigin;
  confidence: number;
}

export interface DecompileReport {
  formatVersion: 1;
  input: {
    filename?: string;
    sha256?: string;
    target: Target;
  };
  fingerprint: {
    jsConfuserConfidence: number;
    family: string | null;
    versionCandidates: Record<string, number>;
  };
  transforms: Record<string, number>;
  passes: PassActionRecord[];
  runtime: {
    executions: number;
    traces: number;
    generatedCodeCaptured: number;
  };
  recovery: {
    strings: { found: number; recovered: number };
    cfg: { blocks: number; recovered: number };
    [key: string]: unknown;
  };
  naming: NamingRecord[];
  validation: {
    safe: {
      syntax: boolean | null;
      differential: boolean | null;
    };
    clean: {
      syntax: boolean | null;
      differential: boolean | null;
      confidence: number | null;
    };
  };
  warnings: Diagnostic[];
  errors: Diagnostic[];
}

export interface DecompileResult {
  safeCode: string;
  cleanCode: string;
  ast: {
    safe: t.File;
    clean: t.File;
  };
  report: DecompileReport;
}
