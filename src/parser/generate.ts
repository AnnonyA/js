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

const moduleValue = generatorModule as unknown as {
  default?: GenerateFunction;
  generate?: GenerateFunction;
};
const generate = (
  typeof generatorModule === "function"
    ? generatorModule
    : moduleValue.default ?? moduleValue.generate
) as GenerateFunction | undefined;

export function generateJavaScript(ast: t.File): string {
  if (!generate) {
    throw new TypeError("@babel/generator did not expose a generate function");
  }

  return `${generate(ast, {
    comments: true,
    compact: false,
    retainLines: false,
  }).code}\n`;
}
