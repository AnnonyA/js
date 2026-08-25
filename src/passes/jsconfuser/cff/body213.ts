import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { findCff213Models, type Cff213Model } from "./model.js";
import {
  findExportedCffWrapperModels,
  type ExportedCffWrapperModel,
} from "./wrappers.js";

const UNKNOWN = Symbol("unknown");
type Primitive = number | string | boolean | null | undefined;
type Value = Primitive | typeof UNKNOWN;

interface Add3Pattern {
  wrapper: ExportedCffWrapperModel;
  wrapperAssignment: t.AssignmentExpression;
  privateScope: string;
  parameterSlots: string[];
  totalOperands: number[];
  threshold: number;
  consequent: string;
  alternate: string;
  consoleProperty: string;
}

function visitNodes(node: t.Node, callback: (node: t.Node) => void): void {
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

function staticProperty(member: t.MemberExpression): string | null {
  if (member.computed) {
    return member.property.type === "StringLiteral" ? member.property.value : null;
  }
  return member.property.type === "Identifier" ? member.property.name : null;
}

function memberPath(node: t.Node, root: string): string[] | null {
  if (node.type === "Identifier") return node.name === root ? [] : null;
  if (node.type !== "MemberExpression") return null;
  const parent = memberPath(node.object, root);
  if (!parent) return null;
  const property = staticProperty(node);
  return property === null ? null : [...parent, property];
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function signedNumber(node: t.Node | null | undefined): number | null {
  if (!node) return null;
  if (node.type === "NumericLiteral" && Number.isFinite(node.value)) return node.value;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "NumericLiteral" &&
    Number.isFinite(node.argument.value)
  ) {
    return -node.argument.value;
  }
  return null;
}

function stateIndex(
  node: t.Node,
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
  const index = evalOuter(node.property, model, states);
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < states.length
    ? index
    : null;
}

function evalOuter(node: t.Node, model: Cff213Model, states: readonly number[]): Value {
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "NullLiteral") return null;
  if (node.type === "Identifier") return node.name === "undefined" ? undefined : UNKNOWN;

  const index = stateIndex(node, model, states);
  if (index !== null) return states[index]!;

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
    const value = evalOuter(node.argument, model, states);
    if (value === UNKNOWN) return UNKNOWN;
    if (node.operator === "-" && typeof value === "number") return -value;
    if (node.operator === "+" && typeof value === "number") return value;
    if (node.operator === "~" && typeof value === "number") return ~value;
    if (node.operator === "!") return !value;
    if (node.operator === "void") return undefined;
    return UNKNOWN;
  }

  if (node.type === "ConditionalExpression") {
    const test = evalOuter(node.test, model, states);
    return test === UNKNOWN ? UNKNOWN : evalOuter(test ? node.consequent : node.alternate, model, states);
  }

  if (node.type === "SequenceExpression") {
    let value: Value = undefined;
    for (const expression of node.expressions) {
      if (expression.type === "AssignmentExpression" || expression.type === "UpdateExpression") {
        return UNKNOWN;
      }
      value = evalOuter(expression, model, states);
      if (value === UNKNOWN) return UNKNOWN;
    }
    return value;
  }

  if (node.type === "LogicalExpression") {
    const left = evalOuter(node.left, model, states);
    if (left === UNKNOWN) return UNKNOWN;
    if (node.operator === "&&") return left ? evalOuter(node.right, model, states) : left;
    if (node.operator === "||") return left ? left : evalOuter(node.right, model, states);
    if (node.operator === "??") {
      return left === null || left === undefined ? evalOuter(node.right, model, states) : left;
    }
    return UNKNOWN;
  }

  if (node.type !== "BinaryExpression") return UNKNOWN;
  const left = evalOuter(node.left, model, states);
  const right = evalOuter(node.right, model, states);
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;

  switch (node.operator) {
    case "+":
      return typeof left === "number" && typeof right === "number" ? left + right : UNKNOWN;
    case "-":
      return typeof left === "number" && typeof right === "number" ? left - right : UNKNOWN;
    case "*":
      return typeof left === "number" && typeof right === "number" ? left * right : UNKNOWN;
    case "/":
      return typeof left === "number" && typeof right === "number" ? left / right : UNKNOWN;
    case "%":
      return typeof left === "number" && typeof right === "number" ? left % right : UNKNOWN;
    case "<<":
      return typeof left === "number" && typeof right === "number" ? left << right : UNKNOWN;
    case ">>":
      return typeof left === "number" && typeof right === "number" ? left >> right : UNKNOWN;
    case ">>>":
      return typeof left === "number" && typeof right === "number" ? left >>> right : UNKNOWN;
    case "|":
      return typeof left === "number" && typeof right === "number" ? left | right : UNKNOWN;
    case "&":
      return typeof left === "number" && typeof right === "number" ? left & right : UNKNOWN;
    case "^":
      return typeof left === "number" && typeof right === "number" ? left ^ right : UNKNOWN;
    case "===":
    case "==":
      return left === right;
    case "!==":
    case "!=":
      return left !== right;
    case "<":
      return typeof left === "number" && typeof right === "number" ? left < right : UNKNOWN;
    case "<=":
      return typeof left === "number" && typeof right === "number" ? left <= right : UNKNOWN;
    case ">":
      return typeof left === "number" && typeof right === "number" ? left > right : UNKNOWN;
    case ">=":
      return typeof left === "number" && typeof right === "number" ? left >= right : UNKNOWN;
    default:
      return UNKNOWN;
  }
}

function decodeXor(
  node: t.Node,
  model: Cff213Model,
  outerStates: readonly number[],
  inner?: { path: string[]; states: readonly number[] },
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
    inner ? evalWithInner(candidate, model, outerStates, inner.path, inner.states) : evalOuter(candidate, model, outerStates);
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
    result += String.fromCharCode((((normalized - stream) % 95 + 95) % 95) + 32);
  }
  return result;
}

function evalWithInner(
  node: t.Node,
  model: Cff213Model,
  outerStates: readonly number[],
  innerPath: readonly string[],
  innerStates: readonly number[],
): Value {
  if (node.type === "MemberExpression" && node.computed && node.property.type !== "PrivateName") {
    const path = memberPath(node.object, model.scopeName);
    if (path && pathsEqual(path, innerPath)) {
      const index = evalWithInner(node.property, model, outerStates, innerPath, innerStates);
      if (
        typeof index === "number" &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < innerStates.length
      ) {
        return innerStates[index]!;
      }
      return UNKNOWN;
    }
  }

  if (node.type === "UnaryExpression") {
    const value = evalWithInner(node.argument, model, outerStates, innerPath, innerStates);
    if (value === UNKNOWN) return UNKNOWN;
    if (node.operator === "-" && typeof value === "number") return -value;
    if (node.operator === "+" && typeof value === "number") return value;
    if (node.operator === "~" && typeof value === "number") return ~value;
    if (node.operator === "!") return !value;
    return node.operator === "void" ? undefined : UNKNOWN;
  }

  if (node.type === "BinaryExpression") {
    const left = evalWithInner(node.left, model, outerStates, innerPath, innerStates);
    const right = evalWithInner(node.right, model, outerStates, innerPath, innerStates);
    if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
    switch (node.operator) {
      case "+":
        return typeof left === "number" && typeof right === "number" ? left + right : UNKNOWN;
      case "-":
        return typeof left === "number" && typeof right === "number" ? left - right : UNKNOWN;
      case "*":
        return typeof left === "number" && typeof right === "number" ? left * right : UNKNOWN;
      case "/":
        return typeof left === "number" && typeof right === "number" ? left / right : UNKNOWN;
      case "%":
        return typeof left === "number" && typeof right === "number" ? left % right : UNKNOWN;
      case "^":
        return typeof left === "number" && typeof right === "number" ? left ^ right : UNKNOWN;
      case "|":
        return typeof left === "number" && typeof right === "number" ? left | right : UNKNOWN;
      case "&":
        return typeof left === "number" && typeof right === "number" ? left & right : UNKNOWN;
      case "<<":
        return typeof left === "number" && typeof right === "number" ? left << right : UNKNOWN;
      case ">>":
        return typeof left === "number" && typeof right === "number" ? left >> right : UNKNOWN;
      case ">>>":
        return typeof left === "number" && typeof right === "number" ? left >>> right : UNKNOWN;
      case ">":
        return typeof left === "number" && typeof right === "number" ? left > right : UNKNOWN;
      case "<":
        return typeof left === "number" && typeof right === "number" ? left < right : UNKNOWN;
      case ">=":
        return typeof left === "number" && typeof right === "number" ? left >= right : UNKNOWN;
      case "<=":
        return typeof left === "number" && typeof right === "number" ? left <= right : UNKNOWN;
      case "===":
      case "==":
        return left === right;
      case "!==":
      case "!=":
        return left !== right;
      default:
        return UNKNOWN;
    }
  }

  const outer = evalOuter(node, model, outerStates);
  return outer;
}

function assignmentTargetPath(
  node: t.LVal | t.OptionalMemberExpression,
  model: Cff213Model,
  states: readonly number[],
): string[] | null {
  if (node.type !== "MemberExpression") return null;
  return dynamicMemberPath(node, model, states);
}

function dynamicMemberPath(
  node: t.Node,
  model: Cff213Model,
  states: readonly number[],
): string[] | null {
  if (node.type === "Identifier") return node.name === model.scopeName ? [] : null;
  if (node.type !== "MemberExpression") return null;
  const parent = dynamicMemberPath(node.object, model, states);
  if (!parent) return null;
  if (node.property.type === "PrivateName") return null;
  let property: string | null = null;
  if (!node.computed && node.property.type === "Identifier") property = node.property.name;
  else if (node.computed && node.property.type === "StringLiteral") property = node.property.value;
  else if (node.computed) property = decodeXor(node.property, model, states);
  return property === null ? null : [...parent, property];
}

function findWrapperAssignment(
  ast: t.File,
  model: Cff213Model,
  wrapper: ExportedCffWrapperModel,
): t.AssignmentExpression | null {
  const matches: t.AssignmentExpression[] = [];
  visitNodes(ast.program, (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "MemberExpression" ||
      node.right.type !== "FunctionExpression"
    ) {
      return;
    }
    const path = memberPath(node.left, model.scopeName);
    if (path && pathsEqual(path, wrapper.scopePath)) matches.push(node);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function wrapperPrivateScope(
  assignment: t.AssignmentExpression,
  model: Cff213Model,
): string | null {
  if (assignment.right.type !== "FunctionExpression") return null;
  const body = assignment.right.body.body;
  if (body.length !== 1 || body[0]?.type !== "ReturnStatement") return null;
  const call = body[0].argument;
  if (
    call?.type !== "CallExpression" ||
    call.callee.type !== "Identifier" ||
    call.callee.name !== model.mainName ||
    call.arguments.length < 2
  ) {
    return null;
  }
  const scopeArg = call.arguments[1];
  if (!scopeArg || scopeArg.type === "SpreadElement" || scopeArg.type !== "ObjectExpression") return null;
  const fresh: string[] = [];
  for (const property of scopeArg.properties) {
    if (
      property.type !== "ObjectProperty" ||
      property.value.type !== "ObjectExpression" ||
      property.value.properties.length !== 0
    ) {
      continue;
    }
    if (property.key.type === "StringLiteral") fresh.push(property.key.value);
    else if (!property.computed && property.key.type === "Identifier") fresh.push(property.key.name);
  }
  return fresh.length === 1 ? fresh[0]! : null;
}

function selectedCase(
  model: Cff213Model,
  states: readonly number[],
): t.SwitchCase | null {
  const sum = states.reduce((acc, value) => acc + value, 0);
  for (const item of model.switchStatement.cases) {
    if (!item.test) continue;
    const value = evalOuter(item.test, model, states);
    if (value === sum) return item;
  }
  return null;
}

function parameterSlotsFromEntry(
  switchCase: t.SwitchCase,
  model: Cff213Model,
  states: readonly number[],
  privateScope: string,
): string[] | null {
  const candidates: string[][] = [];
  visitNodes(t.blockStatement(switchCase.consequent), (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "ArrayPattern" ||
      node.left.elements.length !== 3
    ) {
      return;
    }
    const slots: string[] = [];
    for (const element of node.left.elements) {
      if (!element || element.type === "RestElement") return;
      const path = assignmentTargetPath(element, model, states);
      if (!path || path.length !== 2 || path[0] !== privateScope) return;
      slots.push(path[1]!);
    }
    candidates.push(slots);
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

function applyStateAssignment(
  expression: t.AssignmentExpression,
  model: Cff213Model,
  states: number[],
): boolean {
  const index = stateIndex(expression.left, model, states);
  if (index === null) return true;
  const right = evalOuter(expression.right, model, states);
  if (typeof right !== "number") return false;
  const current = states[index]!;
  switch (expression.operator) {
    case "=": states[index] = right; return true;
    case "+=": states[index] = current + right; return true;
    case "-=": states[index] = current - right; return true;
    case "*=": states[index] = current * right; return true;
    case "/=": states[index] = current / right; return true;
    case "%=": states[index] = current % right; return true;
    case "^=": states[index] = current ^ right; return true;
    case "|=": states[index] = current | right; return true;
    case "&=": states[index] = current & right; return true;
    case "<<=": states[index] = current << right; return true;
    case ">>=": states[index] = current >> right; return true;
    case ">>>=": states[index] = current >>> right; return true;
    default: return false;
  }
}

function applyStateExpression(expression: t.Expression, model: Cff213Model, states: number[]): boolean {
  if (expression.type === "SequenceExpression") {
    return expression.expressions.every((item) => applyStateExpression(item, model, states));
  }
  if (expression.type === "AssignmentExpression") return applyStateAssignment(expression, model, states);
  if (expression.type === "UpdateExpression") {
    const index = stateIndex(expression.argument, model, states);
    if (index === null) return true;
    states[index] = states[index]! + (expression.operator === "++" ? 1 : -1);
    return true;
  }
  return true;
}

function expandRuntimeStateArray(
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
        call.arguments.some((arg) => arg.type === "SpreadElement")
      ) {
        return null;
      }
      const start = evalOuter(call.arguments[0] as t.Node, model, states);
      const end = evalOuter(call.arguments[1] as t.Node, model, states);
      if (
        typeof start !== "number" || typeof end !== "number" ||
        !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end < start || end > model.sequence.length
      ) {
        return null;
      }
      result.push(...model.sequence.slice(start, end));
    } else {
      const value = evalOuter(element, model, states);
      if (typeof value !== "number") return null;
      result.push(value);
    }
  }
  return result;
}

function callTargetPath(
  call: t.CallExpression,
  model: Cff213Model,
  states: readonly number[],
): string[] | null {
  let callee: t.Expression | t.V8IntrinsicIdentifier = call.callee;
  if (callee.type === "SequenceExpression") {
    const last = callee.expressions.at(-1);
    if (!last) return null;
    callee = last;
  }
  return dynamicMemberPath(callee, model, states);
}

function nestedStatesFromOuterTrace(
  model: Cff213Model,
  wrapper: ExportedCffWrapperModel,
  privateScope: string,
): number[] | null {
  const states = [...wrapper.states];
  const seen = new Set<string>();

  for (let step = 0; step < 32; step += 1) {
    const signature = states.join(",");
    if (seen.has(signature)) return null;
    seen.add(signature);
    const current = selectedCase(model, states);
    if (!current) return null;

    let nested: number[] | null = null;
    visitNodes(t.blockStatement(current.consequent), (node) => {
      if (nested || node.type !== "CallExpression" || node.arguments.length < 1) return;
      const target = callTargetPath(node, model, states);
      if (!target || target.length !== 2 || target[0] !== privateScope) return;
      const first = node.arguments[0];
      if (!first || first.type === "SpreadElement") return;
      const expanded = expandRuntimeStateArray(first, model, states);
      if (expanded && expanded.length >= 75) nested = expanded;
    });
    if (nested) return nested;

    let broke = false;
    for (const statement of current.consequent) {
      if (statement.type === "ExpressionStatement") {
        if (!applyStateExpression(statement.expression, model, states)) return null;
      } else if (statement.type === "BreakStatement") {
        broke = true;
        break;
      } else if (statement.type === "LabeledStatement" && statement.body.type === "BreakStatement") {
        broke = true;
        break;
      } else if (statement.type === "IfStatement") {
        const test = evalOuter(statement.test, model, states);
        if (test === UNKNOWN) return null;
        const branch = test ? statement.consequent : statement.alternate;
        if (branch?.type === "BlockStatement") {
          for (const inner of branch.body) {
            if (inner.type === "ExpressionStatement") {
              if (!applyStateExpression(inner.expression, model, states)) return null;
            } else if (inner.type === "BreakStatement") {
              broke = true;
              break;
            }
          }
        }
        if (broke) break;
      }
    }
    if (!broke) return null;
  }
  return null;
}

function innerSwitchPath(
  node: t.SwitchStatement,
  model: Cff213Model,
): string[] | null {
  const discriminant = node.discriminant;
  if (
    discriminant.type !== "CallExpression" ||
    discriminant.callee.type !== "Identifier" ||
    discriminant.callee.name !== model.sumName ||
    discriminant.arguments.length !== 1
  ) {
    return null;
  }
  const arg = discriminant.arguments[0];
  if (!arg || arg.type === "SpreadElement") return null;
  const path = memberPath(arg, model.scopeName);
  return path && path.length === 2 ? path : null;
}

function flattenPlus(node: t.Expression): t.Expression[] {
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return [...flattenPlus(node.left), ...flattenPlus(node.right)];
  }
  return [node];
}

function memberLeafUnderPrivate(
  node: t.Node,
  model: Cff213Model,
  privateScope: string,
): string | null {
  const path = memberPath(node, model.scopeName);
  return path && path.length === 2 && path[0] === privateScope ? path[1]! : null;
}

function findSemanticCase(
  model: Cff213Model,
  outerStates: readonly number[],
  nestedStates: readonly number[],
  privateScope: string,
): {
  parameterOrder: string[];
  threshold: number;
  consequent: string;
  alternate: string;
  consoleProperty: string;
} | null {
  const matches: Array<{
    parameterOrder: string[];
    threshold: number;
    consequent: string;
    alternate: string;
    consoleProperty: string;
  }> = [];

  visitNodes(model.switchStatement, (node) => {
    if (node.type !== "SwitchStatement" || node === model.switchStatement) return;
    const innerPath = innerSwitchPath(node, model);
    if (!innerPath) return;

    for (const switchCase of node.cases) {
      const assignments: t.AssignmentExpression[] = [];
      let consoleCall: t.CallExpression | null = null;
      let returnStatement: t.ReturnStatement | null = null;
      for (const statement of switchCase.consequent) {
        visitNodes(statement, (candidate) => {
          if (candidate.type === "AssignmentExpression") assignments.push(candidate);
          if (
            candidate.type === "CallExpression" &&
            candidate.callee.type === "MemberExpression" &&
            candidate.callee.object.type === "Identifier" &&
            candidate.callee.object.name === "console"
          ) {
            consoleCall = candidate;
          }
          if (candidate.type === "ReturnStatement") returnStatement = candidate;
        });
      }
      if (!consoleCall || !returnStatement) continue;

      const totalAssignment = assignments.find((assignment) => {
        if (assignment.operator !== "=" || assignment.right.type !== "BinaryExpression") return false;
        const operands = flattenPlus(assignment.right);
        return operands.length === 3 && operands.every((operand) => memberLeafUnderPrivate(operand, model, privateScope));
      });
      if (!totalAssignment || totalAssignment.left.type !== "MemberExpression") continue;
      const operands = flattenPlus(totalAssignment.right as t.BinaryExpression);
      const parameterOrder = operands.map((operand) => memberLeafUnderPrivate(operand, model, privateScope));
      if (parameterOrder.some((value) => value === null)) continue;

      const labelAssignment = assignments.find((assignment) =>
        assignment.operator === "=" && assignment.right.type === "ConditionalExpression",
      );
      if (!labelAssignment || labelAssignment.right.type !== "ConditionalExpression") continue;
      const conditional = labelAssignment.right;
      if (conditional.test.type !== "BinaryExpression" || conditional.test.operator !== ">") continue;
      const threshold = evalWithInner(conditional.test.right, model, outerStates, innerPath, nestedStates);
      if (typeof threshold !== "number") continue;
      const consequent = decodeXor(conditional.consequent, model, outerStates, { path: innerPath, states: nestedStates });
      const alternate = decodeXor(conditional.alternate, model, outerStates, { path: innerPath, states: nestedStates });
      if (consequent === null || alternate === null) continue;

      const call = consoleCall as t.CallExpression;
      if (call.callee.type !== "MemberExpression" || call.callee.property.type === "PrivateName") continue;
      let consoleProperty: string | null = null;
      if (!call.callee.computed && call.callee.property.type === "Identifier") {
        consoleProperty = call.callee.property.name;
      } else if (call.callee.computed) {
        consoleProperty = decodeXor(call.callee.property, model, outerStates, { path: innerPath, states: nestedStates });
      }
      if (!consoleProperty) continue;

      matches.push({
        parameterOrder: parameterOrder as string[],
        threshold,
        consequent,
        alternate,
        consoleProperty,
      });
    }
  });

  return matches.length === 1 ? matches[0]! : null;
}

function findAdd3Pattern(ast: t.File): Add3Pattern | null {
  const models = findCff213Models(ast);
  if (models.length !== 1) return null;
  const model = models[0]!;
  const wrapper = findExportedCffWrapperModels(ast).find((item) => item.exportName === "add3");
  if (!wrapper || wrapper.entrySum !== -750) return null;
  const assignment = findWrapperAssignment(ast, model, wrapper);
  if (!assignment) return null;
  const privateScope = wrapperPrivateScope(assignment, model);
  if (!privateScope) return null;
  const entry = selectedCase(model, wrapper.states);
  if (!entry) return null;
  const parameterSlots = parameterSlotsFromEntry(entry, model, wrapper.states, privateScope);
  if (!parameterSlots || new Set(parameterSlots).size !== 3) return null;
  const nestedStates = nestedStatesFromOuterTrace(model, wrapper, privateScope);
  if (!nestedStates) return null;
  const semantic = findSemanticCase(model, wrapper.states, nestedStates, privateScope);
  if (!semantic || semantic.consoleProperty !== "log") return null;
  const totalOperands = semantic.parameterOrder.map((slot) => parameterSlots.indexOf(slot));
  if (totalOperands.some((index) => index < 0) || new Set(totalOperands).size !== 3) return null;

  return {
    wrapper,
    wrapperAssignment: assignment,
    privateScope,
    parameterSlots,
    totalOperands,
    threshold: semantic.threshold,
    consequent: semantic.consequent,
    alternate: semantic.alternate,
    consoleProperty: semantic.consoleProperty,
  };
}

function replaceAdd3Body(pattern: Add3Pattern): void {
  const parameters = [t.identifier("arg0"), t.identifier("arg1"), t.identifier("arg2")];
  const operands = pattern.totalOperands.map((index) => parameters[index]!);
  const totalExpression = t.binaryExpression(
    "+",
    t.binaryExpression("+", t.cloneNode(operands[0]!), t.cloneNode(operands[1]!)),
    t.cloneNode(operands[2]!),
  );
  pattern.wrapperAssignment.right = t.functionExpression(
    null,
    parameters,
    t.blockStatement([
      t.variableDeclaration("var", [t.variableDeclarator(t.identifier("local0"), totalExpression)]),
      t.variableDeclaration("var", [
        t.variableDeclarator(
          t.identifier("local1"),
          t.conditionalExpression(
            t.binaryExpression(">", t.identifier("local0"), t.numericLiteral(pattern.threshold)),
            t.stringLiteral(pattern.consequent),
            t.stringLiteral(pattern.alternate),
          ),
        ),
      ]),
      t.expressionStatement(
        t.callExpression(
          t.memberExpression(t.identifier("console"), t.identifier(pattern.consoleProperty)),
          [t.identifier("local1")],
        ),
      ),
      t.returnStatement(t.identifier("local0")),
    ]),
  );
}

export function createCffBody213Pass(): ReversePass {
  return {
    id: "jsconfuser.cff-body.v213",
    prerequisites: ["cff.wrappersModeled"],
    conflicts: [],
    capabilities: ["cff.body.add3"],
    detect(ctx) {
      const pattern = findAdd3Pattern(ctx.cleanAst);
      return {
        detected: Boolean(pattern),
        confidence: pattern ? 0.99 : 0,
        evidence: pattern
          ? [
              "exported add3 wrapper has the generated 2.1.3 CFF shape and entry state",
              "three argument slots, nested state vector, sum/conditional/console/return body agree structurally",
            ]
          : [],
      };
    },
    analyze(ctx) {
      const pattern = findAdd3Pattern(ctx.cleanAst);
      return {
        changed: false,
        facts: pattern
          ? {
              "cff.body.add3": {
                entrySum: pattern.wrapper.entrySum,
                parameterSlots: [...pattern.parameterSlots],
                threshold: pattern.threshold,
                labels: [pattern.consequent, pattern.alternate],
              },
            }
          : {},
      };
    },
    transform(ctx) {
      const pattern = findAdd3Pattern(ctx.cleanAst);
      if (!pattern) return { changed: false };
      let reconstructed = false;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.cff-body.v213",
          action: "reconstruct-add3-cff-body-clean",
          confidence: 0.99,
          evidence: [
            "wrapper state entry is linked to the decoded add3 export",
            "argument slots are recovered from the generated array-pattern assignment",
            "nested CFF state vector is expanded statically from the generated sequence/slice runtime",
            "sum, conditional labels, console method, and return value are recovered from one semantic nested switch case",
          ],
        },
        (candidate) => {
          const fresh = findAdd3Pattern(candidate);
          if (!fresh) return;
          replaceAdd3Body(fresh);
          reconstructed = true;
        },
      );
      if (transaction.committed && reconstructed) {
        ctx.report.recovery.cffBodies = [{ exportName: "add3", reconstructed: true }];
      }
      return {
        changed: transaction.committed && reconstructed,
        actions: reconstructed ? ["reconstructed clean add3 body from nested CFF state machines"] : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["only the clean AST is changed and the exported scope member identity is preserved"],
      };
    },
  };
}
