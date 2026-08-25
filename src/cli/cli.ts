#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { runCli, type CliRunOptions } from "./run.js";
import type { DynamicMode, Target } from "../types.js";

function parseTarget(value: string): Target {
  if (value === "auto" || value === "node" || value === "browser") return value;
  throw new InvalidArgumentError("expected auto, node, or browser");
}

function parseDynamic(value: string): DynamicMode {
  if (value === "off" || value === "auto" || value === "aggressive") return value;
  throw new InvalidArgumentError("expected off, auto, or aggressive");
}

function parseConfidence(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("expected a number between 0 and 1");
  }
  return parsed;
}

const program = new Command();
program
  .name("jsconfuser-decompile")
  .argument("<input>", "JavaScript input file")
  .option("--target <auto|node|browser>", "execution target", parseTarget)
  .option("--dynamic <off|auto|aggressive>", "dynamic analysis mode", parseDynamic)
  .option("--config <file>", "js-confuser configuration JSON")
  .option("--out <directory>", "output directory")
  .option("--safe-only", "write only safe output")
  .option("--clean-only", "write only clean output")
  .option("--no-dynamic", "disable dynamic analysis")
  .option("--trace", "enable tracing")
  .option("--report", "write report")
  .option("--confidence <number>", "confidence threshold", parseConfidence)
  .option("--analyze-only", "analyze without reversing")
  .action(async (input: string, rawOptions: Record<string, unknown>) => {
    const dynamicValue = rawOptions.dynamic;
    const options: CliRunOptions = {
      target: rawOptions.target as Target | undefined,
      dynamic:
        dynamicValue === false
          ? "off"
          : (dynamicValue as DynamicMode | undefined),
      configPath: rawOptions.config as string | undefined,
      outputDirectory: rawOptions.out as string | undefined,
      safeOnly: rawOptions.safeOnly as boolean | undefined,
      cleanOnly: rawOptions.cleanOnly as boolean | undefined,
      trace: rawOptions.trace as boolean | undefined,
      report: rawOptions.report as boolean | undefined,
      confidence: rawOptions.confidence as number | undefined,
      analyzeOnly: rawOptions.analyzeOnly as boolean | undefined,
    };
    await runCli(input, options);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
