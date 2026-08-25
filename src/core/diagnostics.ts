export type DiagnosticCode =
  | "PARSE_ERROR"
  | "PASS_DETECTION_FAILED"
  | "PASS_TRANSFORM_FAILED"
  | "SYMBOLIC_LIMIT"
  | "CFG_LIMIT"
  | "SANDBOX_TIMEOUT"
  | "SANDBOX_MEMORY_LIMIT"
  | "SANDBOX_RUNTIME_ERROR"
  | "DIFFERENTIAL_MISMATCH"
  | "UNSUPPORTED_PATTERN"
  | "UNKNOWN_JS_CONFUSER_VERSION";

export type DiagnosticSeverity = "warning" | "error";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  passId?: string;
  range?: { start: number; end: number };
  cause?: string;
}

export type DiagnosticDetails = Omit<
  Diagnostic,
  "code" | "severity" | "message"
>;

export class DiagnosticBag {
  readonly #items: Diagnostic[] = [];

  warn(
    code: DiagnosticCode,
    message: string,
    details: DiagnosticDetails = {},
  ): Diagnostic {
    return this.#add("warning", code, message, details);
  }

  error(
    code: DiagnosticCode,
    message: string,
    details: DiagnosticDetails = {},
  ): Diagnostic {
    return this.#add("error", code, message, details);
  }

  all(): Diagnostic[] {
    return [...this.#items];
  }

  warnings(): Diagnostic[] {
    return this.#items.filter((item) => item.severity === "warning");
  }

  errors(): Diagnostic[] {
    return this.#items.filter((item) => item.severity === "error");
  }

  #add(
    severity: DiagnosticSeverity,
    code: DiagnosticCode,
    message: string,
    details: DiagnosticDetails,
  ): Diagnostic {
    const diagnostic: Diagnostic = { code, severity, message, ...details };
    this.#items.push(diagnostic);
    return diagnostic;
  }
}
