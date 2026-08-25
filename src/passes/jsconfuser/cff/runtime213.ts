import * as t from "@babel/types";
import type { Cff213Model } from "./model.js";

export const UNKNOWN = Symbol("unknown");
export type Value = number | string | boolean | null | undefined | typeof UNKNOWN;

export interface InnerStateContext {
  path: readonly string[];
  states: readonly number[];
}

export function visitNodes(node: t.Node, callback: (node: t.Node) => void): void {
  callback(node);
  const record = node as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { type?: unknown }).type === "string"
        ) {
          visitNodes(item as t.Node, callback);
        }
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      visitNodes(value as t.Node, callback);
    }
  }
}

export function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function staticMemberPath(node: t.Node, root: string): string[] | null {
  if (node.type === "Identifier") return node.name === root ? [] : null;
  if (node.type !== "MemberExpression") return null;
  const parent = staticMemberPath(node.object, root);
  if (!parent || node.property.type === "PrivateName") return null;
  const property = node.computed
    ? node.property.type === "StringLiteral"
      ? node.property.value
      : null
    : node.property.type === "Identifier"
      ? node.property.name
      : null;
  return property === null ? null : [...parent, property];
}

function evaluateBinary(
  operator: t.BinaryExpression["operator"],
  left: Value,
  right: Value,
): Value {
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
  switch (operator) {
    case "+": return typeof left === "number" && typeof right === "number" ? left + right : UNKNOWN;
    case "-": return typeof left === "number" && typeof right === "number" ? left - right : UNKNOWN;
    case "*": return typeof left === "number" && typeof right === "number" ? left * right : UNKNOWN;
    case "/": return typeof left === "number" && typeof right === "number" ? left / right : UNKNOWN;
    case "%": return typeof left === "number" && typeof right === "number" ? left % right : UNKNOWN;
    case "<<": return typeof left === "number" && typeof right === "number" ? left << right : UNKNOWN;
    case ">>": return typeof left === "number" && typeof right === "number" ? left >> right : UNKNOWN;
    case ">>>": return typeof left === "number" && typeof right === "number" ? left >>> right : UNKNOWN;
    case "|": return typeof left === "number" && typeof right === "number" ? left | right : UNKNOWN;
    case "&": return typeof left === "number" && typeof right === "number" ? left & right : UNKNOWN;
    case "^": return typeof left === "number" && typeof right === "number" ? left ^ right : UNKNOWN;
    case "===":
    case "==": return left === right;
    case "!==":
    case "!=": return left !== right;
    case "<": return typeof left === "number" && typeof right === "number" ? left < right : UNKNOWN;
    case "<=": return typeof left === "number" && typeof right === "number" ? left <= right : UNKNOWN;
    case ">": return typeof left === "number" && typeof right === "number" ? left > right : UNKNOWN;
    case ">=": return typeof left === "number" && typeof right === "number" ? left >= right : UNKNOWN;
    default: return UNKNOWN;
  }
}

function stateIndex(node: t.Node, model: Cff213Model, states: readonly number[]): number | null {
  if (
    node.type !== "MemberExpression" ||
    node.object.type !== "Identifier" ||
    node.object.name !== model.statesName ||
    !node.computed ||
    node.property.type === "PrivateName"
  ) {
    return null;
  }
  const value = evaluateOuter(node.property, model, states);
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < states.length
    ? value
    : null;
}

export function evaluateOuter(
  node: t.Node,
  model: Cff213Model,
  states: readonly number[],
): Value {
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "NullLiteral") return null;
  if (node.type === "Identifier") return node.name === "undefined" ? undefined : UNKNOWN;

  const index = stateIndex(node, model, states);
  if (index !== null) return states[index]!;

  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === model.sumName &&
    node.arguments.length === 1 &&
    node.arguments[0]?.type === "Identifier" &&
    node.arguments[0].name === model.statesName
  ) {
    return states.reduce((sum, value) => sum + value, 0);
  }

  if (node.type === "UnaryExpression") {
    const value = evaluateOuter(node.argument, model, states);
    if (value === UNKNOWN) return UNKNOWN;
    if (node.operator === "-" && typeof value === "number") return -value;
    if (node.operator === "+" && typeof value === "number") return value;
    if (node.operator === "~" && typeof value === "number") return ~value;
    if (node.operator === "!") return !value;
    if (node.operator === "void") return undefined;
    return UNKNOWN;
  }

  if (node.type === "ConditionalExpression") {
    const test = evaluateOuter(node.test, model, states);
    return test === UNKNOWN
      ? UNKNOWN
      : evaluateOuter(test ? node.consequent : node.alternate, model, states);
  }

  if (node.type === "LogicalExpression") {
    const left = evaluateOuter(node.left, model, states);
    if (left === UNKNOWN) return UNKNOWN;
    if (node.operator === "&&") return left ? evaluateOuter(node.right, model, states) : left;
    if (node.operator === "||") return left ? left : evaluateOuter(node.right, model, states);
    return left === null || left === undefined ? evaluateOuter(node.right, model, states) : left;
  }

  if (node.type === "SequenceExpression") {
    let result: Value = undefined;
    for (const expression of node.expressions) {
      if (expression.type === "AssignmentExpression" || expression.type === "UpdateExpression") {
        return UNKNOWN;
      }
      result = evaluateOuter(expression, model, states);
      if (result === UNKNOWN) return UNKNOWN;
    }
    return result;
  }

  if (node.type === "BinaryExpression") {
    if (!t.isExpression(node.left) || !t.isExpression(node.right)) return UNKNOWN;
    return evaluateBinary(
      node.operator,
      evaluateOuter(node.left, model, states),
      evaluateOuter(node.right, model, states),
    );
  }
  return UNKNOWN;
}

export function evaluateInner(
  node: t.Node,
  model: Cff213Model,
  outerStates: readonly number[],
  innerPath: readonly string[],
  innerStates: readonly number[],
): Value {
  if (node.type === "MemberExpression" && node.computed && node.property.type !== "PrivateName") {
    const path = staticMemberPath(node.object, model.scopeName);
    if (path && pathsEqual(path, innerPath)) {
      const index = evaluateInner(node.property, model, outerStates, innerPath, innerStates);
      return typeof index === "number" &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < innerStates.length
        ? innerStates[index]!
        : UNKNOWN;
    }
  }
  if (node.type === "UnaryExpression") {
    const value = evaluateInner(node.argument, model, outerStates, innerPath, innerStates);
    if (value === UNKNOWN) return UNKNOWN;
    if (node.operator === "-" && typeof value === "number") return -value;
    if (node.operator === "+" && typeof value === "number") return value;
    if (node.operator === "~" && typeof value === "number") return ~value;
    if (node.operator === "!") return !value;
    if (node.operator === "void") return undefined;
    return UNKNOWN;
  }
  if (node.type === "BinaryExpression") {
    if (!t.isExpression(node.left) || !t.isExpression(node.right)) return UNKNOWN;
    return evaluateBinary(
      node.operator,
      evaluateInner(node.left, model, outerStates, innerPath, innerStates),
      evaluateInner(node.right, model, outerStates, innerPath, innerStates),
    );
  }
  return evaluateOuter(node, model, outerStates);
}

export function decodeXor(
  node: t.Node,
  model: Cff213Model,
  outerStates: readonly number[],
  inner?: InnerStateContext,
): string | null {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "Identifier" ||
    node.callee.name !== model.xorName ||
    node.arguments.length !== 3 ||
    node.arguments.some((argument) => argument.type === "SpreadElement")
  ) {
    return null;
  }
  const evaluate = (candidate: t.Node): Value =>
    inner
      ? evaluateInner(candidate, model, outerStates, inner.path, inner.states)
      : evaluateOuter(candidate, model, outerStates);
  const key = evaluate(node.arguments[0] as t.Node);
  const start = evaluate(node.arguments[1] as t.Node);
  const length = evaluate(node.arguments[2] as t.Node);
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
  let rolling = key;
  let result = "";
  for (let index = 0; index < length; index += 1) {
    rolling = (rolling + 2654435769) | 0;
    const stream = (((rolling ^ (rolling >>> 13)) % 95) + 95) % 95;
    const normalized = model.stringsValue.charCodeAt(start + index) - 32;
    result += String.fromCharCode(((((normalized - stream) % 95) + 95) % 95) + 32);
  }
  return result;
}

export function dynamicMemberPath(
  node: t.Node,
  model: Cff213Model,
  outerStates: readonly number[],
  inner?: InnerStateContext,
): string[] | null {
  if (node.type === "Identifier") return node.name === model.scopeName ? [] : null;
  if (node.type !== "MemberExpression") return null;
  const parent = dynamicMemberPath(node.object, model, outerStates, inner);
  if (!parent || node.property.type === "PrivateName") return null;
  const property = !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : node.computed && node.property.type === "StringLiteral"
      ? node.property.value
      : node.computed
        ? decodeXor(node.property, model, outerStates, inner)
        : null;
  return property === null ? null : [...parent, property];
}

export function selectedCaseIndex(model: Cff213Model, states: readonly number[]): number | null {
  const sum = states.reduce((acc, value) => acc + value, 0);
  for (let index = 0; index < model.switchStatement.cases.length; index += 1) {
    const switchCase = model.switchStatement.cases[index]!;
    if (!switchCase.test) continue;
    if (evaluateOuter(switchCase.test, model, states) === sum) return index;
  }
  return null;
}

function applyStateAssignment(
  expression: t.AssignmentExpression,
  model: Cff213Model,
  states: number[],
): boolean {
  const index = stateIndex(expression.left, model, states);
  if (index === null) return true;
  const right = evaluateOuter(expression.right, model, states);
  if (typeof right !== "number") return false;
  const current = states[index]!;
  switch (expression.operator) {
    case "=": states[index] = right; break;
    case "+=": states[index] = current + right; break;
    case "-=": states[index] = current - right; break;
    case "*=": states[index] = current * right; break;
    case "/=": states[index] = current / right; break;
    case "%=": states[index] = current % right; break;
    case "^=": states[index] = current ^ right; break;
    case "|=": states[index] = current | right; break;
    case "&=": states[index] = current & right; break;
    case "<<=": states[index] = current << right; break;
    case ">>=": states[index] = current >> right; break;
    case ">>>=": states[index] = current >>> right; break;
    default: return false;
  }
  return true;
}

export function applyStateExpression(
  expression: t.Expression,
  model: Cff213Model,
  states: number[],
): boolean {
  if (expression.type === "SequenceExpression") {
    for (const item of expression.expressions) {
      if (!applyStateExpression(item, model, states)) return false;
    }
    return true;
  }
  if (expression.type === "AssignmentExpression") return applyStateAssignment(expression, model, states);
  if (expression.type === "UpdateExpression") {
    const index = stateIndex(expression.argument, model, states);
    if (index !== null) states[index] = states[index]! + (expression.operator === "++" ? 1 : -1);
  }
  return true;
}

export function expandRuntimeStateArray(
  node: t.Node,
  model: Cff213Model,
  states: readonly number[],
): number[] | null {
  if (node.type !== "ArrayExpression") return null;
  const result: number[] = [];
  for (const element of node.elements) {
    if (!element) return null;
    if (element.type === "SpreadElement") {
      const call = element.argument;
      if (
        call.type !== "CallExpression" ||
        call.callee.type !== "Identifier" ||
        call.callee.name !== model.sliceName ||
        call.arguments.length !== 2 ||
        call.arguments.some((argument) => argument.type === "SpreadElement")
      ) return null;
      const start = evaluateOuter(call.arguments[0] as t.Node, model, states);
      const end = evaluateOuter(call.arguments[1] as t.Node, model, states);
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end > model.sequence.length
      ) return null;
      result.push(...model.sequence.slice(start, end));
    } else {
      const value = evaluateOuter(element, model, states);
      if (typeof value !== "number") return null;
      result.push(value);
    }
  }
  return result;
}
