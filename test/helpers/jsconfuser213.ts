import { obfuscate, type ObfuscateOptions } from "js-confuser";

export type JsConfuser213Options = Partial<ObfuscateOptions>;

export async function obfuscate213(
  source: string,
  options: JsConfuser213Options,
  seed?: number,
): Promise<string> {
  void seed;
  const result = await obfuscate(source, {
    target: "node",
    compact: true,
    ...options,
  } as ObfuscateOptions);
  return result.code;
}
