import type * as t from "@babel/types";
import { generateJavaScript } from "../parser/generate.js";
import { parseJavaScript } from "../parser/parse.js";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateSyntax(ast: t.File): ValidationResult {
  try {
    const generated = generateJavaScript(ast);
    parseJavaScript(generated);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
