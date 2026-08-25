import type * as t from "@babel/types";
import type { DecompilerContext } from "../../core/context.js";
import { fingerprintProgram } from "../detector.js";
import { isEmptyFunction, propertyName, walk } from "./ast.js";
import { detection, type DetectionResult } from "./types.js";

function countCallsByProperty(ast: t.File, property: string): number {
  let count = 0;
  walk(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      propertyName(node.callee) === property
    ) {
      count += 1;
    }
  });
  return count;
}

function countBitwise(ast: t.File): number {
  let count = 0;
  walk(ast, (node) => {
    if (
      node.type === "BinaryExpression" &&
      ["^", "&", "|", ">>", ">>>", "<<"].includes(node.operator)
    ) {
      count += 1;
    }
    if (
      node.type === "AssignmentExpression" &&
      ["^=", "&=", "|=", ">>=", ">>>=", "<<="].includes(node.operator)
    ) {
      count += 1;
    }
  });
  return count;
}

export function detectStringConcealing(ctx: DecompilerContext): DetectionResult {
  let longStrings = 0;
  let textDecoder = false;
  let byteArrayRuntime = false;
  walk(ctx.inputAst, (node) => {
    if (node.type === "StringLiteral" && node.value.length >= 128) longStrings += 1;
    if (node.type === "Identifier" && node.name === "TextDecoder") textDecoder = true;
    if (
      node.type === "Identifier" &&
      ["Uint8Array", "Buffer"].includes(node.name)
    ) {
      byteArrayRuntime = true;
    }
  });

  const indexOf = countCallsByProperty(ctx.inputAst, "indexOf");
  const slice = countCallsByProperty(ctx.inputAst, "slice");
  const bitwise = countBitwise(ctx.inputAst);
  const evidence: string[] = [];
  if (longStrings > 0) evidence.push("long encoded string table");
  if (indexOf > 0) evidence.push("decoder index lookup");
  if (slice > 0) evidence.push("substring table slicing");
  if (bitwise >= 4) evidence.push("bitwise byte decoder");
  if (textDecoder && byteArrayRuntime) evidence.push("byte-to-string runtime");

  if (
    longStrings > 0 &&
    indexOf > 0 &&
    slice > 0 &&
    bitwise >= 4 &&
    textDecoder &&
    byteArrayRuntime
  ) {
    return detection(0.98, evidence);
  }
  if (evidence.length >= 4) return detection(0.65, evidence);
  return detection(Math.min(0.35, evidence.length * 0.08), evidence);
}

export function detectGlobalConcealing(ctx: DecompilerContext): DetectionResult {
  const globals = new Set<string>();
  let returnThisFactory = false;
  let largeMappingSwitch = 0;

  walk(ctx.inputAst, (node) => {
    if (
      node.type === "Identifier" &&
      ["globalThis", "global", "window"].includes(node.name)
    ) {
      globals.add(node.name);
    }
    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Function" &&
      node.arguments.some(
        (argument) =>
          argument.type === "StringLiteral" && argument.value.includes("return this"),
      )
    ) {
      returnThisFactory = true;
    }
    if (node.type === "SwitchStatement" && node.cases.length >= 10) {
      const memberReturns = node.cases.filter((switchCase) =>
        switchCase.consequent.some(
          (statement) =>
            statement.type === "ReturnStatement" &&
            statement.argument?.type === "MemberExpression",
        ),
      ).length;
      if (memberReturns >= 8) largeMappingSwitch += 1;
    }
  });

  const evidence: string[] = [];
  if (globals.size >= 2) evidence.push("multi-environment global resolver");
  if (returnThisFactory) evidence.push("Function return-this fallback");
  if (largeMappingSwitch > 0) evidence.push("large concealed-global mapping switch");

  if (globals.size >= 2 && returnThisFactory && largeMappingSwitch > 0) {
    return detection(0.99, evidence);
  }
  if (largeMappingSwitch > 0) return detection(0.7, evidence);
  return detection(Math.min(0.3, evidence.length * 0.1), evidence);
}

export function detectVariableMasking(ctx: DecompilerContext): DetectionResult {
  let maskedFunctions = 0;
  let indexedAccesses = 0;

  walk(ctx.inputAst, (node) => {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression"
    ) {
      return;
    }
    if (node.params.length !== 1 || node.params[0]?.type !== "RestElement") return;
    if (node.params[0].argument.type !== "Identifier") return;
    const restName = node.params[0].argument.name;
    let lengthAssignment = false;
    let accesses = 0;

    walk(node.body, (child) => {
      if (
        child.type === "MemberExpression" &&
        child.object.type === "Identifier" &&
        child.object.name === restName &&
        child.computed
      ) {
        accesses += 1;
      }
      if (
        child.type === "AssignmentExpression" &&
        child.left.type === "MemberExpression" &&
        child.left.object.type === "Identifier" &&
        child.left.object.name === restName &&
        propertyName(child.left) === "length"
      ) {
        lengthAssignment = true;
      }
    });

    if (lengthAssignment && accesses >= 4) {
      maskedFunctions += 1;
      indexedAccesses += accesses;
    }
  });

  const evidence = maskedFunctions
    ? [
        `${maskedFunctions} rest-parameter variable-mask functions`,
        `${indexedAccesses} indexed scope accesses`,
      ]
    : [];
  if (maskedFunctions >= 2) return detection(0.99, evidence);
  if (maskedFunctions === 1) return detection(0.72, evidence);
  return detection(0, evidence);
}

export function detectDispatcher(ctx: DecompilerContext): DetectionResult {
  let objectCreateNull = false;
  let functionMap = false;
  let applyThis = false;
  let restWrappers = 0;
  let newDispatcherCalls = 0;

  walk(ctx.inputAst, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      propertyName(node.callee) === "create" &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type === "NullLiteral"
    ) {
      objectCreateNull = true;
    }
    if (node.type === "ObjectExpression") {
      const functions = node.properties.filter(
        (property) =>
          property.type === "ObjectProperty" &&
          (property.value.type === "FunctionExpression" ||
            property.value.type === "ArrowFunctionExpression"),
      ).length;
      if (functions >= 3) functionMap = true;
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      propertyName(node.callee) === "apply" &&
      node.arguments[0]?.type === "ThisExpression"
    ) {
      applyThis = true;
    }
    if (
      (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
      node.params.length === 1 &&
      node.params[0]?.type === "RestElement"
    ) {
      restWrappers += 1;
    }
    if (node.type === "NewExpression" && node.callee.type === "Identifier") {
      newDispatcherCalls += 1;
    }
  });

  const evidence: string[] = [];
  if (objectCreateNull) evidence.push("null-prototype dispatcher cache");
  if (functionMap) evidence.push("function opcode map");
  if (applyThis) evidence.push("dispatcher apply(this) wrapper");
  if (restWrappers > 0) evidence.push("rest-argument wrapper");
  if (newDispatcherCalls > 0) evidence.push("constructor-style dispatcher access");

  if (objectCreateNull && functionMap && applyThis && restWrappers > 0) {
    return detection(0.98, evidence);
  }
  if (evidence.length >= 3) return detection(0.65, evidence);
  return detection(Math.min(0.3, evidence.length * 0.08), evidence);
}

export function detectControlFlowFlattening(
  ctx: DecompilerContext,
): DetectionResult {
  const fingerprint = fingerprintProgram(ctx);
  const matched = new Set(
    fingerprint.evidence.filter((item) => item.matched).map((item) => item.id),
  );
  const stateArray =
    matched.has("cff.largeNumericStateArray") ||
    matched.has("cff.signedNumericStateArray");
  const strong = [
    "cff.crossIndexedStateMutation",
    "cff.stateStringXorHelper",
    "cff.stateSumHelper",
    "cff.recursiveDispatcher",
    "cff.callDiscriminant",
  ].filter((id) => matched.has(id));
  const evidence = [
    ...(stateArray ? ["large state array"] : []),
    ...strong,
  ];

  if (stateArray && strong.length >= 2) return detection(0.99, evidence);
  if (matched.has("cff.whileSwitch") && strong.length >= 1) {
    return detection(0.68, evidence);
  }
  if (matched.has("cff.whileSwitch")) return detection(0.2, ["while/switch only"]);
  return detection(0);
}

function dummyFunctionSignals(ctx: DecompilerContext): {
  emptyFunctions: Set<string>;
  inChecks: number;
  deadHelpers: number;
} {
  const emptyFunctions = new Set<string>();
  let inChecks = 0;
  let deadHelpers = 0;

  walk(ctx.inputAst, (node) => {
    if (node.type === "FunctionDeclaration" && node.id && isEmptyFunction(node)) {
      emptyFunctions.add(node.id.name);
    }
    if (
      node.type === "FunctionDeclaration" &&
      node.id?.name.includes("_dead_")
    ) {
      deadHelpers += 1;
    }
  });
  walk(ctx.inputAst, (node) => {
    if (
      node.type === "BinaryExpression" &&
      node.operator === "in" &&
      node.right.type === "Identifier" &&
      emptyFunctions.has(node.right.name) &&
      node.left.type === "StringLiteral"
    ) {
      inChecks += 1;
    }
  });

  return { emptyFunctions, inChecks, deadHelpers };
}

export function detectOpaquePredicates(ctx: DecompilerContext): DetectionResult {
  const signals = dummyFunctionSignals(ctx);
  const evidence: string[] = [];
  if (signals.emptyFunctions.size > 0) evidence.push("empty dummy function");
  if (signals.inChecks >= 2) evidence.push(`${signals.inChecks} dummy membership predicates`);
  if (signals.deadHelpers === 0 && signals.inChecks >= 2) {
    evidence.push("predicate-only dummy guard topology");
  }

  if (
    signals.emptyFunctions.size > 0 &&
    signals.inChecks >= 2 &&
    signals.deadHelpers === 0
  ) {
    return detection(0.96, evidence);
  }
  if (signals.inChecks >= 2) return detection(0.55, evidence);
  return detection(0);
}

export function detectDeadCode(ctx: DecompilerContext): DetectionResult {
  const signals = dummyFunctionSignals(ctx);
  const evidence: string[] = [];
  if (signals.emptyFunctions.size > 0) evidence.push("empty dummy function");
  if (signals.inChecks >= 2) evidence.push(`${signals.inChecks} dummy membership guards`);
  if (signals.deadHelpers >= 2) evidence.push(`${signals.deadHelpers} injected dead helpers`);
  if (ctx.source.length >= 3000) evidence.push("large injected payload");

  if (
    signals.emptyFunctions.size > 0 &&
    signals.inChecks >= 2 &&
    signals.deadHelpers >= 2 &&
    ctx.source.length >= 3000
  ) {
    return detection(0.99, evidence);
  }
  if (signals.deadHelpers >= 1 && signals.inChecks >= 1) {
    return detection(0.7, evidence);
  }
  return detection(0);
}

function randomishIdentifier(name: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{4,10}$/.test(name)) return false;
  const hasUpper = /[A-Z]/.test(name);
  const hasLower = /[a-z]/.test(name);
  const hasDigit = /\d/.test(name);
  return (hasUpper && hasLower) || (hasDigit && (hasUpper || hasLower));
}

export function detectRenameVariables(ctx: DecompilerContext): DetectionResult {
  let exportPairs = 0;
  let mismatches = 0;
  let randomValues = 0;

  walk(ctx.inputAst, (node) => {
    if (node.type !== "AssignmentExpression") return;
    if (node.left.type !== "MemberExpression") return;
    if (propertyName(node.left) !== "exports") return;
    if (node.right.type !== "ObjectExpression") return;

    for (const property of node.right.properties) {
      if (property.type !== "ObjectProperty" || property.value.type !== "Identifier") {
        continue;
      }
      let key: string | null = null;
      if (property.key.type === "StringLiteral") key = property.key.value;
      if (!property.computed && property.key.type === "Identifier") key = property.key.name;
      if (!key) continue;
      exportPairs += 1;
      if (key !== property.value.name) mismatches += 1;
      if (randomishIdentifier(property.value.name)) randomValues += 1;
    }
  });

  const evidence: string[] = [];
  if (exportPairs >= 3) evidence.push(`${exportPairs} named export bindings`);
  if (mismatches >= 3) evidence.push(`${mismatches} export/name mismatches`);
  if (randomValues >= 2) evidence.push(`${randomValues} random-looking binding names`);

  if (exportPairs >= 3 && mismatches >= 3 && randomValues >= 2) {
    return detection(0.9, evidence);
  }
  if (mismatches >= 2 && randomValues >= 2) return detection(0.62, evidence);
  return detection(0, evidence);
}
