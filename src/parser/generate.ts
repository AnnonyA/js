import generatorModule from "@babel/generator";
import type * as t from "@babel/types";

interface GeneratorOptions {
  comments?: boolean;
  compact?: boolean;
  retainLines?: boolean;
}

interface GeneratorOutput {
  code: string;
}

type GenerateFunction = (ast: t.Node, options?: GeneratorOptions) => GeneratorOutput;

const generate = generatorModule as unknown as GenerateFunction;

export function generateJavaScript(ast: t.File): string {
  return `${generate(ast, {
    comments: true,
    compact: false,
    retainLines: false,
  }).code}\n`;
}
