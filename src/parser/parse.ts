import { parse } from "@babel/parser";
import type * as t from "@babel/types";

export function parseJavaScript(source: string, filename = "input.js"): t.File {
  return parse(source, {
    sourceType: "unambiguous",
    sourceFilename: filename,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    errorRecovery: false,
    plugins: ["jsx", "typescript", "topLevelAwait", "importAttributes"],
  });
}
