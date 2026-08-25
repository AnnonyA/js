import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  createDecompiler,
  type DecompilerSession,
} from "../core/decompiler.js";
import type {
  DecompileOptions,
  DecompileResult,
  DynamicMode,
  JsConfuserOptions,
  Target,
} from "../types.js";

export interface DecompileFileOptions extends DecompileOptions {
  outputDirectory?: string;
  analyzeOnly?: boolean;
}

export interface CliRunOptions {
  target?: Target;
  dynamic?: DynamicMode;
  configPath?: string;
  outputDirectory?: string;
  safeOnly?: boolean;
  cleanOnly?: boolean;
  trace?: boolean;
  report?: boolean;
  confidence?: number;
  analyzeOnly?: boolean;
}

function outputBase(inputPath: string): string {
  const filename = basename(inputPath);
  const extension = extname(filename);
  return extension.length > 0 ? filename.slice(0, -extension.length) : filename;
}

async function writeOutputs(
  inputPath: string,
  session: DecompilerSession,
  result: DecompileResult,
  options: DecompileFileOptions,
): Promise<void> {
  const outputDirectory = resolve(
    options.outputDirectory ?? join(dirname(inputPath), "decompiled"),
  );
  await mkdir(outputDirectory, { recursive: true });

  const base = outputBase(inputPath);
  if (!options.analyzeOnly && session.options.output.safe) {
    await writeFile(join(outputDirectory, `${base}.safe.js`), result.safeCode, "utf8");
  }
  if (!options.analyzeOnly && session.options.output.clean) {
    await writeFile(join(outputDirectory, `${base}.clean.js`), result.cleanCode, "utf8");
  }
  if (options.analyzeOnly || session.options.output.report) {
    await writeFile(
      join(outputDirectory, `${base}.report.json`),
      `${JSON.stringify(result.report, null, 2)}\n`,
      "utf8",
    );
  }
}

export async function decompileFile(
  inputPath: string,
  options: DecompileFileOptions = {},
): Promise<DecompileResult> {
  const absoluteInputPath = resolve(inputPath);
  const source = await readFile(absoluteInputPath, "utf8");
  const { outputDirectory: _outputDirectory, analyzeOnly, ...decompileOptions } = options;
  const session = createDecompiler(decompileOptions);

  await session.parse(source, absoluteInputPath);
  await session.analyze();
  if (!analyzeOnly) {
    await session.reverse();
    await session.validate();
  }

  const result = session.result();
  await writeOutputs(absoluteInputPath, session, result, options);
  return result;
}

async function readConfig(path: string | undefined): Promise<JsConfuserOptions | undefined> {
  if (!path) return undefined;
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--config must contain a JSON object");
  }
  return parsed as JsConfuserOptions;
}

export async function runCli(
  inputPath: string,
  options: CliRunOptions = {},
): Promise<DecompileResult> {
  if (options.safeOnly && options.cleanOnly) {
    throw new Error("--safe-only and --clean-only cannot be used together");
  }
  if (
    options.confidence !== undefined &&
    (!Number.isFinite(options.confidence) || options.confidence < 0 || options.confidence > 1)
  ) {
    throw new Error("--confidence must be a number between 0 and 1");
  }

  const config = await readConfig(options.configPath);
  const output = {
    safe: !options.cleanOnly,
    clean: !options.safeOnly,
    report: options.report ?? true,
  };

  return decompileFile(inputPath, {
    target: options.target,
    dynamic: options.dynamic,
    ...(config === undefined ? {} : { config }),
    output,
    ...(options.confidence === undefined
      ? {}
      : {
          confidence: {
            safeThreshold: options.confidence,
            cleanThreshold: options.confidence,
          },
        }),
    tracing: {
      enabled: options.trace ?? false,
      level: options.trace ? 1 : 0,
    },
    outputDirectory: options.outputDirectory,
    analyzeOnly: options.analyzeOnly,
  });
}
