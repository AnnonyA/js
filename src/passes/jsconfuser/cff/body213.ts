import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { findCff213Models, type Cff213Model } from "./model.js";
import {
  findExportedCffWrapperModels,
  type ExportedCffWrapperModel,
} from "./wrappers.js";

const UNKNOWN = Symbol("unknown");
type Value = number | string | boolean | null | undefined | typeof UNKNOWN;

interface Add3Pattern {
  wrapper: ExportedCffWrapperModel;
  wrapperAssignment: t.AssignmentExpression;
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

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function staticMemberPath(node: t.Node, root: string): string[] | null {
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
  const index = evaluateOuter(node.property, model, states);
  return typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < states.length
    ? index
    : null;
}

function evaluateBinary(operator: t.BinaryExpression["operator"], left: Value, right: Value): Value {
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

function evaluateOuter(node: t.Node, model: Cff213Model, states: readonly number[]): Value {
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
    let value: Value = undefined;
    for (const expression of node.expressions) {
      if (expression.type === "AssignmentExpression" || expression.type === "UpdateExpression") return UNKNOWN;
      value = evaluateOuter(expression, model, states);
      if (value === UNKNOWN) return UNKNOWN;
    }
    return value;
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

function evaluateInner(
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

function decodeXor(
  node: t.Node,
  model: Cff213Model,
  outerStates: readonly number[],
  inner?: { path: readonly string[]; states: readonly number[] },
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

function dynamicMemberPath(
  node: t.Node,
  model: Cff213Model,
  states: readonly number[],
): string[] | null {
  if (node.type === "Identifier") return node.name === model.scopeName ? [] : null;
  if (node.type !== "MemberExpression") return null;
  const parent = dynamicMemberPath(node.object, model, states);
  if (!parent || node.property.type === "PrivateName") return null;
  const property = !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : node.computed && node.property.type === "StringLiteral"
      ? node.property.value
      : node.computed
        ? decodeXor(node.property, model, states)
        : null;
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
    ) return;
    const path = staticMemberPath(node.left, model.scopeName);
    if (path && pathsEqual(path, wrapper.scopePath)) matches.push(node);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function wrapperPrivateScope(assignment: t.AssignmentExpression, model: Cff213Model): string | null {
  if (assignment.right.type !== "FunctionExpression") return null;
  const statement = assignment.right.body.body[0];
  if (assignment.right.body.body.length !== 1 || statement?.type !== "ReturnStatement") return null;
  const call = statement.argument;
  if (
    call?.type !== "CallExpression" ||
    call.callee.type !== "Identifier" ||
    call.callee.name !== model.mainName ||
    call.arguments.length < 2
  ) return null;
  const scopeArg = call.arguments[1];
  if (!scopeArg || scopeArg.type === "SpreadElement" || scopeArg.type !== "ObjectExpression") return null;
  const fresh: string[] = [];
  for (const property of scopeArg.properties) {
    if (
      property.type !== "ObjectProperty" ||
      property.value.type !== "ObjectExpression" ||
      property.value.properties.length !== 0
    ) continue;
    if (property.key.type === "StringLiteral") fresh.push(property.key.value);
    else if (!property.computed && property.key.type === "Identifier") fresh.push(property.key.name);
  }
  return fresh.length === 1 ? fresh[0]! : null;
}

function selectedCaseIndex(model: Cff213Model, states: readonly number[]): number | null {
  const sum = states.reduce((acc, value) => acc + value, 0);
  for (let index = 0; index < model.switchStatement.cases.length; index += 1) {
    const item = model.switchStatement.cases[index]!;
    if (!item.test) continue;
    const value = evaluateOuter(item.test, model, states);
    if (value === sum) return index;
  }
  return null;
}

function parameterSlotsFromEntry(
  model: Cff213Model,
  wrapper: ExportedCffWrapperModel,
  privateScope: string,
): string[] | null {
  const index = selectedCaseIndex(model, wrapper.states);
  if (index === null) return null;
  const candidates: string[][] = [];
  for (let cursor = index; cursor < model.switchStatement.cases.length; cursor += 1) {
    const current = model.switchStatement.cases[cursor]!;
    visitNodes(t.blockStatement(current.consequent), (node) => {
      if (
        node.type !== "AssignmentExpression" ||
        node.operator !== "=" ||
        node.left.type !== "ArrayPattern" ||
        node.left.elements.length !== 3
      ) return;
      const slots: string[] = [];
      for (const element of node.left.elements) {
        if (!element || element.type === "RestElement" || !t.isNode(element)) return;
        const path = dynamicMemberPath(element, model, wrapper.states);
        if (!path || path.length !== 2 || path[0] !== privateScope) return;
        slots.push(path[1]!);
      }
      candidates.push(slots);
    });
    if (current.consequent.some((statement) => statement.type === "BreakStatement")) break;
  }
  return candidates.length === 1 ? candidates[0]! : null;
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

function applyStateExpression(expression: t.Expression, model: Cff213Model, states: number[]): boolean {
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
        call.arguments.some((argument) => argument.type === "SpreadElement")
      ) return null;
      const start = evaluateOuter(call.arguments[0] as t.Node, model, states);
      const end = evaluateOuter(call.arguments[1] as t.Node, model, states);
      if (
        typeof start !== "number" || typeof end !== "number" ||
        !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end < start || end > model.sequence.length
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

function callTargetPath(call: t.CallExpression, model: Cff213Model, states: readonly number[]): string[] | null {
  const raw = call.callee;
  if (!t.isExpression(raw)) return null;
  const callee = raw.type === "SequenceExpression" ? raw.expressions.at(-1) : raw;
  return callee && t.isNode(callee) ? dynamicMemberPath(callee, model, states) : null;
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
    const selected = selectedCaseIndex(model, states);
    if (selected === null) return null;
    let repeated = false;
    for (let cursor = selected; cursor < model.switchStatement.cases.length; cursor += 1) {
      const current = model.switchStatement.cases[cursor]!;
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

      for (const statement of current.consequent) {
        if (statement.type === "ExpressionStatement") {
          if (!applyStateExpression(statement.expression, model, states)) return null;
        } else if (statement.type === "BreakStatement") {
          repeated = true;
          break;
        } else if (statement.type === "IfStatement") {
          const test = evaluateOuter(statement.test, model, states);
          if (test === UNKNOWN) return null;
          const branch = test ? statement.consequent : statement.alternate;
          if (branch?.type === "BlockStatement") {
            for (const inner of branch.body) {
              if (inner.type === "ExpressionStatement") {
                if (!applyStateExpression(inner.expression, model, states)) return null;
              } else if (inner.type === "BreakStatement") {
                repeated = true;
                break;
              }
            }
          }
        }
        if (repeated) break;
      }
      if (repeated) break;
    }
    if (!repeated) return null;
  }
  return null;
}

function innerSwitchPath(node: t.SwitchStatement, model: Cff213Model): string[] | null {
  const discriminant = node.discriminant;
  if (
    discriminant.type !== "CallExpression" ||
    discriminant.callee.type !== "Identifier" ||
    discriminant.callee.name !== model.sumName ||
    discriminant.arguments.length !== 1
  ) return null;
  const argument = discriminant.arguments[0];
  if (!argument || argument.type === "SpreadElement") return null;
  const path = staticMemberPath(argument, model.scopeName);
  return path && path.length === 2 ? path : null;
}

function flattenPlus(node: t.Node): t.Expression[] | null {
  if (node.type === "BinaryExpression" && node.operator === "+") {
    if (!t.isExpression(node.left) || !t.isExpression(node.right)) return null;
    const left = flattenPlus(node.left);
    const right = flattenPlus(node.right);
    return left && right ? [...left, ...right] : null;
  }
  return t.isExpression(node) ? [node] : null;
}

function privateLeaf(node: t.Node, model: Cff213Model, privateScope: string): string | null {
  const path = staticMemberPath(node, model.scopeName);
  return path && path.length === 2 && path[0] === privateScope ? path[1]! : null;
}

function semanticBody(
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
      let hasReturn = false;
      for (const statement of switchCase.consequent) {
        visitNodes(statement, (candidate) => {
          if (candidate.type === "AssignmentExpression") assignments.push(candidate);
          if (candidate.type === "ReturnStatement") hasReturn = true;
          if (
            candidate.type === "CallExpression" &&
            candidate.callee.type === "MemberExpression" &&
            candidate.callee.object.type === "Identifier" &&
            candidate.callee.object.name === "console"
          ) consoleCall = candidate;
        });
      }
      if (!consoleCall || !hasReturn) continue;

      let totalOperands: t.Expression[] | null = null;
      for (const assignment of assignments) {
        if (assignment.operator !== "=" || assignment.right.type !== "BinaryExpression") continue;
        const operands = flattenPlus(assignment.right);
        if (
          operands?.length === 3 &&
          operands.every((operand) => privateLeaf(operand, model, privateScope) !== null)
        ) {
          totalOperands = operands;
          break;
        }
      }
      if (!totalOperands) continue;
      const parameterOrder = totalOperands.map((operand) => privateLeaf(operand, model, privateScope));
      if (parameterOrder.some((slot) => slot === null)) continue;

      const labelAssignment = assignments.find(
        (assignment) => assignment.operator === "=" && assignment.right.type === "ConditionalExpression",
      );
      if (!labelAssignment || labelAssignment.right.type !== "ConditionalExpression") continue;
      const conditional = labelAssignment.right;
      if (
        conditional.test.type !== "BinaryExpression" ||
        conditional.test.operator !== ">" ||
        !t.isExpression(conditional.test.right)
      ) continue;
      const threshold = evaluateInner(
        conditional.test.right,
        model,
        outerStates,
        innerPath,
        nestedStates,
      );
      if (typeof threshold !== "number") continue;
      const consequent = decodeXor(conditional.consequent, model, outerStates, { path: innerPath, states: nestedStates });
      const alternate = decodeXor(conditional.alternate, model, outerStates, { path: innerPath, states: nestedStates });
      if (consequent === null || alternate === null) continue;

      const call = consoleCall as t.CallExpression;
      if (call.callee.type !== "MemberExpression" || call.callee.property.type === "PrivateName") continue;
      const consoleProperty = !call.callee.computed && call.callee.property.type === "Identifier"
        ? call.callee.property.name
        : call.callee.computed
          ? decodeXor(call.callee.property, model, outerStates, { path: innerPath, states: nestedStates })
          : null;
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
  if (!wrapper) return null;
  const wrapperAssignment = findWrapperAssignment(ast, model, wrapper);
  if (!wrapperAssignment) return null;
  const privateScope = wrapperPrivateScope(wrapperAssignment, model);
  if (!privateScope) return null;
  const parameterSlots = parameterSlotsFromEntry(model, wrapper, privateScope);
  if (!parameterSlots || new Set(parameterSlots).size !== 3) return null;
  const nestedStates = nestedStatesFromOuterTrace(model, wrapper, privateScope);
  if (!nestedStates) return null;
  const body = semanticBody(model, wrapper.states, nestedStates, privateScope);
  if (!body || body.consoleProperty !== "log") return null;
  const totalOperands = body.parameterOrder.map((slot) => parameterSlots.indexOf(slot));
  if (totalOperands.some((index) => index < 0) || new Set(totalOperands).size !== 3) return null;
  return {
    wrapper,
    wrapperAssignment,
    parameterSlots,
    totalOperands,
    threshold: body.threshold,
    consequent: body.consequent,
    alternate: body.alternate,
    consoleProperty: body.consoleProperty,
  };
}

function replaceBody(pattern: Add3Pattern): void {
  const params = [t.identifier("arg0"), t.identifier("arg1"), t.identifier("arg2")];
  const ordered = pattern.totalOperands.map((index) => params[index]!);
  pattern.wrapperAssignment.right = t.functionExpression(
    null,
    params,
    t.blockStatement([
      t.variableDeclaration("var", [
        t.variableDeclarator(
          t.identifier("local0"),
          t.binaryExpression(
            "+",
            t.binaryExpression("+", t.cloneNode(ordered[0]!), t.cloneNode(ordered[1]!)),
            t.cloneNode(ordered[2]!),
          ),
        ),
      ]),
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
              "decoded add3 export links to a concrete generated wrapper state",
              "argument slots, nested state vector, sum, conditional labels, console call, and return agree structurally",
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
      if (!findAdd3Pattern(ctx.cleanAst)) return { changed: false };
      let reconstructed = false;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.cff-body.v213",
          action: "reconstruct-add3-cff-body-clean",
          confidence: 0.99,
          evidence: [
            "wrapper entry state is linked to the decoded add3 export",
            "three argument slots are recovered from the generated destructuring assignment",
            "nested state vector is expanded from generated sequence/slice expressions",
            "semantic sum/conditional/console/return case is unique",
          ],
        },
        (candidate) => {
          const pattern = findAdd3Pattern(candidate);
          if (!pattern) return;
          replaceBody(pattern);
          reconstructed = true;
        },
      );
      if (transaction.committed && reconstructed) {
        ctx.report.recovery.cffBodies = [{ exportName: "add3", reconstructed: true }];
      }
      return {
        changed: transaction.committed && reconstructed,
        actions: reconstructed ? ["reconstructed clean add3 body from nested CFF machines"] : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["only clean AST changes; the original scope member identity remains intact"],
      };
    },
  };
}
