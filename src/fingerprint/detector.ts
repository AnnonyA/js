import type { DecompilerContext } from "../core/context.js";
import { collectBabel213Evidence } from "./eras/babel213.js";
import { makeEvidence, scoreEvidence } from "./evidence.js";
import type { FingerprintEvidence, FingerprintResult } from "./types.js";
import { rankVersionCandidates, selectFamily } from "./versions.js";

const CONFIG_HINTS = [
  "controlFlowFlattening",
  "stringConcealing",
  "variableMasking",
  "dispatcher",
  "calculator",
  "globalConcealing",
  "opaquePredicates",
  "deadCode",
  "pack",
] as const;

function configEvidence(ctx: DecompilerContext): FingerprintEvidence[] {
  const config = ctx.options.config;
  if (!config) return [];

  return CONFIG_HINTS.map((key) =>
    makeEvidence(
      `config.${key}`,
      0.12,
      config[key] === true,
      config[key] === true
        ? `original config declares ${key}`
        : `original config does not declare ${key}`,
    ),
  );
}

export function fingerprintProgram(ctx: DecompilerContext): FingerprintResult {
  const evidence = [
    ...collectBabel213Evidence(ctx.inputAst),
    ...configEvidence(ctx),
  ];
  const jsConfuserConfidence = scoreEvidence(evidence);
  const versionCandidates = rankVersionCandidates(
    evidence,
    jsConfuserConfidence,
  );

  return {
    jsConfuserConfidence,
    family: selectFamily(jsConfuserConfidence, versionCandidates),
    versionCandidates,
    evidence,
  };
}
