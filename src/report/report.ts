import type { DecompileReport, Target } from "../types.js";

export function createEmptyReport(target: Target = "auto"): DecompileReport {
  return {
    formatVersion: 1,
    input: {
      target,
    },
    fingerprint: {
      jsConfuserConfidence: 0,
      family: null,
      versionCandidates: {},
    },
    transforms: {},
    passes: [],
    runtime: {
      executions: 0,
      traces: 0,
      generatedCodeCaptured: 0,
    },
    recovery: {
      strings: { found: 0, recovered: 0 },
      cfg: { blocks: 0, recovered: 0 },
    },
    naming: [],
    validation: {
      safe: {
        syntax: null,
        differential: null,
      },
      clean: {
        syntax: null,
        differential: null,
        confidence: null,
      },
    },
    warnings: [],
    errors: [],
  };
}
