import { cloneNode } from "@babel/types";
import type * as t from "@babel/types";
import { DiagnosticBag } from "./diagnostics.js";
import { createEmptyReport } from "../report/report.js";
import type { DecompileReport, ResolvedDecompileOptions } from "../types.js";

export class DecompilerContext {
  readonly source: string;
  readonly filename: string;
  readonly inputAst: t.File;
  safeAst: t.File;
  cleanAst: t.File;
  readonly options: ResolvedDecompileOptions;
  readonly diagnostics: DiagnosticBag;
  readonly report: DecompileReport;
  readonly facts = new Map<string, unknown>();
  readonly capabilities = new Set<string>();
  round = 0;

  constructor(
    source: string,
    filename: string,
    inputAst: t.File,
    options: ResolvedDecompileOptions,
  ) {
    this.source = source;
    this.filename = filename;
    this.inputAst = cloneNode(inputAst, true);
    this.safeAst = cloneNode(inputAst, true);
    this.cleanAst = cloneNode(inputAst, true);
    this.options = options;
    this.diagnostics = new DiagnosticBag();
    this.report = createEmptyReport(options.target);
    this.report.input.filename = filename;
  }
}
