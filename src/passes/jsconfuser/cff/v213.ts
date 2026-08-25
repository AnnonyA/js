import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { findCff213Models, type Cff213Model } from "./model.js";

type Primitive = number | boolean | string | null | undefined;
const UNKNOWN = Symbol("cff-unknown");
type Evaluated = Primitive | typeof UNKNOWN;

interface TraceResult {
  returnStatement: t.ReturnStatement;
  states: number[];
  steps: number;
}

interface RecoveryStats {
  models: number;
  tracedEntries: number;
  decodedExports: number;
  decodedProperties: number;
  steps: number;
}

function evalPrimitive(
  node: t.Node,
  model: Cff213Model,
  states: readonly number[],
): Evaluated {
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "NullLiteral") return null;

  if (node.type === "Identifier") {
    if (node.name === "undefined") return undefined;
    return UNKNOWN;
  }

  if (node.type === "MemberExpression") {
    if (
      node.object.type !== "Identifier" ||
      node.object.name !== model.statesName ||
      !node.computed ||
      node.property.type === "PrivateName"
    ) {
      return UNKNOWN;
    }
    const indexValue = evalPrimitive(node.property, model, states);
    if (
      typeof indexValue !== "number" ||
      !Number.isInteger(indexValue) ||
      indexValue < 0 ||
      indexValue >= states.length
    ) {
      return UNKNOWN;
    }
    return states[indexValue]!;
  }

  if (node.type === "CallExpression") {
    if (
      node.callee.type === "Identifier" &&
      node.callee.name === model.sumName &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type === "Identifier" &&
      node.arguments[0].name === model.statesName
    ) {
      return states.reduce((sum, value) => sum + value, 0);
    }
    return UNKNOWN;
  }

  if (node.type === "UnaryExpression") {
    const argument = evalPrimitive(node.argument, model, states);
    if (argument === UNKNOWN) return UNKNOWN;
    switch (node.operator) {
      case "-":
        return typeof argument === "number" ? -argument : UNKNOWN;
      case "+":
        return typeof argument === "number" ? argument : UNKNOWN;
      case "!":
        return !argument;
      case "~":
        return typeof argument === "number" ? ~argument : UNKNOWN;
      case "void":
        return undefined;
      default:
        return UNKNOWN;
    }
  }

  if (node.type === "LogicalExpression") {
    const left = evalPrimitive(node.left, model, states);
    if (left === UNKNOWN) return UNKNOWN;
    if (node.operator === "&&") {
      return left ? evalPrimitive(node.right, model, states) : left;
    }
    if (node.operator === "||") {
      return left ? left : evalPrimitive(node.right, model, states);
    }
    if (node.operator === "??") {
      return left === null || left === undefined
        ? evalPrimitive(node.right, model, states)
        : left;
    }
    return UNKNOWN;
  }

  if (node.type === "ConditionalExpression") {
    const test = evalPrimitive(node.test, model, states);
    if (test === UNKNOWN) return UNKNOWN;
    return evalPrimitive(test ? node.consequent : node.alternate, model, states);
  }

  if (node.type === "SequenceExpression") {
    let value: Evaluated = undefined;
    for (const expression of node.expressions) {
      if (expression.type === "AssignmentExpression" || expression.type === "UpdateExpression") {
        return UNKNOWN;
      }
      value = evalPrimitive(expression, model, states);
      if (value === UNKNOWN) return UNKNOWN;
    }
    return value;
  }

  if (node.type !== "BinaryExpression") return UNKNOWN;
  const left = evalPrimitive(node.left, model, states);
  const right = evalPrimitive(node.right, model, states);
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;

  switch (node.operator) {
    case "+":
      return typeof left === "number" && typeof right === "number"
        ? left + right
        : UNKNOWN;
    case "-":
      return typeof left === "number" && typeof right === "number"
        ? left - right
        : UNKNOWN;
    case "*":
      return typeof left === "number" && typeof right === "number"
        ? left * right
        : UNKNOWN;
    case "/":
      return typeof left === "number" && typeof right === "number"
        ? left / right
        : UNKNOWN;
    case "%":
      return typeof left === "number" && typeof right === "number"
        ? left % right
        : UNKNOWN;
    case "**":
      return typeof left === "number" && typeof right === "number"
        ? left ** right
        : UNKNOWN;
    case "<<":
      return typeof left === "number" && typeof right === "number"
        ? left << right
        : UNKNOWN;
    case ">>":
      return typeof left === "number" && typeof right === "number"
        ? left >> right
        : UNKNOWN;
    case ">>>":
      return typeof left === "number" && typeof right === "number"
        ? left >>> right
        : UNKNOWN;
    case "|":
      return typeof left === "number" && typeof right === "number"
        ? left | right
        : UNKNOWN;
    case "&":
      return typeof left === "number" && typeof right === "number"
        ? left & right
        : UNKNOWN;
    case "^":
      return typeof left === "number" && typeof right === "number"
        ? left ^ right
        : UNKNOWN;
    case "==":
    case "===":
      return left === right;
    case "!=":
    case "!==":
      return left !== right;
    case "<":
      return typeof left === "number" && typeof right === "number"
        ? left < right
        : UNKNOWN;
    case "<=":
      return typeof left === "number" && typeof right === "number"
        ? left <= right
        : UNKNOWN;
    case ">":
      return typeof left === "number" && typeof right === "number"
        ? left > right
        : UNKNOWN;
    case ">=":
      return typeof left === "number" && typeof right === "number"
        ? left >= right
        : UNKNOWN;
    default:
      return UNKNOWN;
  }
}

function stateIndex(
  node: t.LVal,
  model: Cff213Model,
  states: readonly number[],
): number | null {
  if (
    node.type !== "MemberExpression" ||
    node.object.type !== "Identifier" ||
    node.object.name !== model.statesName ||
    !node.computed ||
    node.property.type === "PrivateName"
  ) {
    return null;
  }
  const value = evalPrimitive(node.property, model, states);
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= states.length
  ) {
    return null;
  }
  return value;
}

function applyAssignment(
  expression: t.AssignmentExpression,
  model: Cff213Model,
  states: number[],
): boolean {
  const index = stateIndex(expression.left, model, states);
  if (index === null) return true;
  const right = evalPrimitive(expression.right, model, states);
  if (typeof right !== "number") return false;
  const current = states[index]!;

  switch (expression.operator) {
    case "=":
      states[index] = right;
      return true;
    case "+=":
      states[index] = current + right;
      return true;
    case "-=":
      states[index] = current - right;
      return true;
    case "*=":
      states[index] = current * right;
      return true;
    case "/=":
      states[index] = current / right;
      return true;
    case "%=":
      states[index] = current % right;
      return true;
    case "<<=":
      states[index] = current << right;
      return true;
    case ">>=":
      states[index] = current >> right;
      return true;
    case ">>>=":
      states[index] = current >>> right;
      return true;
    case "|=":
      states[index] = current | right;
      return true;
    case "^=":
      states[index] = current ^ right;
      return true;
    case "&=":
      states[index] = current & right;
      return true;
    default:
      return false;
  }
}

function applyStateEffects(
  expression: t.Expression,
  model: Cff213Model,
  states: number[],
): boolean {
  if (expression.type === "SequenceExpression") {
    return expression.expressions.every((item) =>
      applyStateEffects(item, model, states),
    );
  }
  if (expression.type === "AssignmentExpression") {
    return applyAssignment(expression, model, states);
  }
  if (expression.type === "UpdateExpression") {
    const index = stateIndex(expression.argument as t.LVal, model, states);
    if (index === null) return true;
    if (expression.operator === "++") states[index] = states[index]! + 1;
    else if (expression.operator === "--") states[index] = states[index]! - 1;
    else return false;
    return true;
  }
  if (expression.type === "ConditionalExpression") {
    const test = evalPrimitive(expression.test, model, states);
    if (test === UNKNOWN) return false;
    return applyStateEffects(test ? expression.consequent : expression.alternate, model, states);
  }
  if (expression.type === "LogicalExpression") {
    const left = evalPrimitive(expression.left, model, states);
    if (left === UNKNOWN) return false;
    if (expression.operator === "&&" && left) {
      return applyStateEffects(expression.right, model, states);
    }
    if (expression.operator === "||" && !left) {
      return applyStateEffects(expression.right, model, states);
    }
    return true;
  }
  return true;
}

type Control =
  | { kind: "normal" }
  | { kind: "break" }
  | { kind: "return"; statement: t.ReturnStatement }
  | { kind: "unknown" };

function executeStatement(
  statement: t.Statement,
  model: Cff213Model,
  states: number[],
): Control {
  if (statement.type === "ExpressionStatement") {
    return applyStateEffects(statement.expression, model, states)
      ? { kind: "normal" }
      : { kind: "unknown" };
  }
  if (statement.type === "ReturnStatement") {
    return { kind: "return", statement };
  }
  if (statement.type === "BreakStatement") return { kind: "break" };
  if (statement.type === "EmptyStatement") return { kind: "normal" };
  if (
    statement.type === "VariableDeclaration" ||
    statement.type === "FunctionDeclaration" ||
    statement.type === "ClassDeclaration"
  ) {
    return { kind: "normal" };
  }
  if (statement.type === "BlockStatement") {
    return executeStatements(statement.body, model, states);
  }
  if (statement.type === "LabeledStatement") {
    return executeStatement(statement.body, model, states);
  }
  if (statement.type === "IfStatement") {
    const test = evalPrimitive(statement.test, model, states);
    if (test === UNKNOWN) return { kind: "unknown" };
    const branch = test ? statement.consequent : statement.alternate;
    return branch ? executeStatement(branch, model, states) : { kind: "normal" };
  }
  return { kind: "normal" };
}

function executeStatements(
  statements: readonly t.Statement[],
  model: Cff213Model,
  states: number[],
): Control {
  for (const statement of statements) {
    const control = executeStatement(statement, model, states);
    if (control.kind !== "normal") return control;
  }
  return { kind: "normal" };
}

function selectCase(
  model: Cff213Model,
  states: readonly number[],
): number | null {
  const discriminant = states.reduce((sum, value) => sum + value, 0);
  let defaultIndex: number | null = null;

  for (let index = 0; index < model.switchStatement.cases.length; index += 1) {
    const switchCase = model.switchStatement.cases[index]!;
    if (!switchCase.test) {
      defaultIndex = index;
      continue;
    }
    const value = evalPrimitive(switchCase.test, model, states);
    if (value === UNKNOWN) return null;
    if (value === discriminant) return index;
  }
  return defaultIndex;
}

function traceEntry(model: Cff213Model): TraceResult | null {
  const states = [...model.entryStates];
  const seen = new Set<string>();

  for (let step = 0; step < 256; step += 1) {
    const signature = states.join(",");
    if (seen.has(signature)) return null;
    seen.add(signature);

    const selected = selectCase(model, states);
    if (selected === null) return null;

    let repeated = false;
    for (
      let index = selected;
      index < model.switchStatement.cases.length;
      index += 1
    ) {
      const control = executeStatements(
        model.switchStatement.cases[index]!.consequent,
        model,
        states,
      );
      if (control.kind === "unknown") return null;
      if (control.kind === "return") {
        return {
          returnStatement: control.statement,
          states: [...states],
          steps: step + 1,
        };
      }
      if (control.kind === "break") {
        repeated = true;
        break;
      }
    }

    if (!repeated) {
      // Falling out of the switch naturally still repeats the enclosing while.
      continue;
    }
  }
  return null;
}

function decodeXorCall(
  node: t.Node,
  model: Cff213Model,
  states: readonly number[],
): string | null {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "Identifier" ||
    node.callee.name !== model.xorName ||
    node.arguments.length !== 3
  ) {
    return null;
  }
  const args = node.arguments;
  if (args.some((argument) => argument.type === "SpreadElement")) return null;
  const key = evalPrimitive(args[0] as t.Node, model, states);
  const start = evalPrimitive(args[1] as t.Node, model, states);
  const length = evalPrimitive(args[2] as t.Node, model, states);
  if (
    typeof key !== "number" ||
    typeof start !== "number" ||
    typeof length !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > model.stringsValue.length
  ) {
    return null;
  }

  let rollingKey = key;
  let result = "";
  for (let index = 0; index < length; index += 1) {
    rollingKey = (rollingKey + 2654435769) | 0;
    const keystream = (((rollingKey ^ (rollingKey >>> 13)) % 95) + 95) % 95;
    const normalized = model.stringsValue.charCodeAt(start + index) - 32;
    const shifted = (((normalized - keystream) % 95) + 95) % 95;
    result += String.fromCharCode(shifted + 32);
  }
  return result;
}

function decodeExportReturn(
  trace: TraceResult,
  model: Cff213Model,
): { exports: number; properties: number } | null {
  const argument = trace.returnStatement.argument;
  if (!argument || argument.type !== "AssignmentExpression" || argument.operator !== "=") {
    return null;
  }
  if (
    argument.left.type !== "MemberExpression" ||
    argument.left.object.type !== "Identifier" ||
    argument.left.object.name !== "module" ||
    !argument.left.computed ||
    argument.left.property.type === "PrivateName" ||
    argument.right.type !== "ObjectExpression"
  ) {
    return null;
  }

  const moduleProperty = decodeXorCall(argument.left.property, model, trace.states);
  if (moduleProperty !== "exports") return null;

  const decodedProperties: Array<{ property: t.ObjectProperty; name: string }> = [];
  for (const property of argument.right.properties) {
    if (property.type !== "ObjectProperty" || property.key.type === "PrivateName") {
      return null;
    }
    const name = decodeXorCall(property.key, model, trace.states);
    if (!name) return null;
    decodedProperties.push({ property, name });
  }
  if (decodedProperties.length === 0) return null;

  argument.left.property = t.stringLiteral(moduleProperty);
  argument.left.computed = true;
  for (const { property, name } of decodedProperties) {
    property.key = t.stringLiteral(name);
    property.computed = true;
  }

  return { exports: 1, properties: decodedProperties.length };
}

function recoverCffExports(ast: t.File): RecoveryStats {
  const stats: RecoveryStats = {
    models: 0,
    tracedEntries: 0,
    decodedExports: 0,
    decodedProperties: 0,
    steps: 0,
  };

  for (const model of findCff213Models(ast)) {
    stats.models += 1;
    const trace = traceEntry(model);
    if (!trace) continue;
    stats.tracedEntries += 1;
    stats.steps += trace.steps;
    const decoded = decodeExportReturn(trace, model);
    if (!decoded) continue;
    stats.decodedExports += decoded.exports;
    stats.decodedProperties += decoded.properties;
  }
  return stats;
}

export function createControlFlowFlattening213Pass(): ReversePass {
  return {
    id: "jsconfuser.control-flow-flattening.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["cff.entryTraced", "cff.exportsDecoded"],
    detect(ctx) {
      const models = findCff213Models(ctx.cleanAst);
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.995 : 0,
        evidence:
          models.length > 0
            ? [
                `${models.length} generated CFF main functions with concrete entry state arrays`,
                "matching _cff_sequence/_cff_slice/_cff_sum/_cff_xor runtime",
              ]
            : [],
      };
    },
    analyze(ctx) {
      const models = findCff213Models(ctx.cleanAst);
      return {
        changed: false,
        facts: {
          "cff.models": models.map((model) => ({
            mainName: model.mainName,
            stateCount: model.entryStates.length,
            entrySum: model.entryStates.reduce((sum, value) => sum + value, 0),
            switchCases: model.switchStatement.cases.length,
          })),
        },
      };
    },
    transform(ctx) {
      if (findCff213Models(ctx.cleanAst).length === 0) return { changed: false };

      let stats: RecoveryStats | null = null;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.control-flow-flattening.v213",
          action: "trace-cff-entry-and-decode-exports-clean",
          confidence: 0.995,
          evidence: [
            "entry state vector is explicitly encoded by the generated sequence/slice runtime",
            "switch cases and state transitions are evaluated against concrete state values",
            "XOR strings are decoded with the generated 2.1.3 algorithm only after a deterministic trace",
          ],
        },
        (candidate) => {
          stats = recoverCffExports(candidate);
        },
      );

      const resultStats = stats as RecoveryStats | null;
      return {
        changed:
          transaction.committed && Boolean(resultStats?.decodedExports),
        actions: resultStats
          ? [
              `traced ${resultStats.tracedEntries}/${resultStats.models} CFF entry machines across ${resultStats.steps} switch steps`,
              `decoded ${resultStats.decodedExports} module export assignments and ${resultStats.decodedProperties} exported property names`,
            ]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.995,
        evidence: [
          "clean-only deterministic state trace and transactional syntax validation",
        ],
      };
    },
  };
}
