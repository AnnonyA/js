import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { obfuscate, type ObfuscateOptions } from "js-confuser";

export type JsConfuser213Options = Partial<ObfuscateOptions>;

export interface FixturePaths {
  directory: string;
  sourcePath: string;
  optionsPath: string;
  obfuscatedPath: string;
  expectedPath: string;
}

function effective213Options(
  options: JsConfuser213Options,
): ObfuscateOptions {
  return {
    target: "node",
    compact: true,
    ...options,
  } as ObfuscateOptions;
}

function withTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export async function obfuscate213(
  source: string,
  options: JsConfuser213Options,
  seed?: number,
): Promise<string> {
  void seed;
  const result = await obfuscate(source, effective213Options(options));
  return result.code;
}

export async function generate213Fixture(
  name: string,
  source: string,
  options: JsConfuser213Options,
): Promise<FixturePaths> {
  const directory = resolve(process.cwd(), "test/fixtures/2.1.3", name);
  const paths: FixturePaths = {
    directory,
    sourcePath: resolve(directory, "source.js"),
    optionsPath: resolve(directory, "options.json"),
    obfuscatedPath: resolve(directory, "obfuscated.js"),
    expectedPath: resolve(directory, "expected.json"),
  };

  const effectiveOptions = effective213Options(options);
  const obfuscated = await obfuscate213(source, options);

  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(paths.sourcePath, withTrailingNewline(source), "utf8"),
    writeFile(
      paths.optionsPath,
      `${JSON.stringify(effectiveOptions, null, 2)}\n`,
      "utf8",
    ),
    writeFile(paths.obfuscatedPath, withTrailingNewline(obfuscated), "utf8"),
    writeFile(
      paths.expectedPath,
      `${JSON.stringify({ parseable: true }, null, 2)}\n`,
      "utf8",
    ),
  ]);

  return paths;
}
