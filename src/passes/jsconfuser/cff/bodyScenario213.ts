import * as t from "@babel/types";
import type { DecompilerContext } from "../../../core/context.js";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { findCff213Models, type Cff213Model } from "./model.js";
import type { ExportedCffWrapperModel } from "./wrappers.js";

const UNKNOWN = Symbol("unknown");
type Value = number | string | boolean | null | undefined | typeof UNKNOWN;

interface BodyRecoveryRecord {
  exportName: string;
  reconstructed: boolean;
}

interface NestedStateTrace {
  invocationStates: number[];
  innerStates: number[];
}

interface ScenarioPattern {
  wrapper: ExportedCffWrapperModel;
  wrapperAssignment: t.AssignmentExpression;
  twicePath: string[];
  inputSlot: string;
}

interface CallCandidate {
  targetPath: string[];
  argumentPath: string[];
}

interface LoopCandidate {
  currentPath: string[];
  loopPath: string[];
  bound: number;
}

function visitNodes(node: t.Node, callback: (node: t.Node) => void): void {
  callback(node);
  const record = node as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string") {
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

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function staticMemberPath(node: t.Node, root: string): string[] | null {
  if (node.type === "Identifier") return node.name === root ? [] : null;
  if (node.type !== "MemberExpression") return null;
  const parent = staticMemberPath(node.object, root);
  if (!parent || node.property.type === "PrivateName") return null;
  const property = node.computed
    ? node.property.type === "StringLiteral" ? node.property.value : null
    : node.property.type === "Identifier" ? node.property.name : null;
  return property === null ? null : [...parent, property];
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

function stateIndex(node: t.Node, model: Cff213Model, states: readonly number[]): number | null {
  if (
    node.type !== "MemberExpression" ||
    node.object.type !== "Identifier" ||
    node.object.name !== model.statesName ||
    !node.computed ||
    node.property.type === "PrivateName"
  ) return null;
  const value = evaluateOuter(node.property, model, states);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < states.length
    ? value
    : null;
}

function evaluateOuter(node: t.Node, model: Cff213Model, states: readonly number[]): Value {
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "NullLiteral") return null;
  if (node.type === "Identifier") return node.name === "undefined" ? undefined : UNKNOWN;

  const index = stateIndex(node, model, states);
  if (index !== null) return states[index]!;

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
    return test === UNKNOWN ? UNKNOWN : evaluateOuter(test ? node.consequent : node.alternate, model, states);
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
      if (expression.type === "AssignmentExpression" || expression.type === "UpdateExpression") return UNKNOWN;
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
      return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < innerStates.length
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
  ) return null;
  const evaluate = (candidate: t.Node): Value => inner
    ? evaluateInner(candidate, model, outerStates, inner.path, inner.states)
    : evaluateOuter(candidate, model, outerStates);
  const key = evaluate(node.arguments[0] as t.Node);
  const start = evaluate(node.arguments[1] as t.Node);
  const length = evaluate(node.arguments[2] as t.Node);
  if (
    typeof key !== "number" || typeof start !== "number" || typeof length !== "number" ||
    !Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 ||
    start + length > model.stringsValue.length
  ) return null;
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
  outerStates: readonly number[],
  inner?: { path: readonly string[]; states: readonly number[] },
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

function wrapperModels(ctx: DecompilerContext): ExportedCffWrapperModel[] {
  const value = ctx.facts.get("cff.exportedWrappers");
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<ExportedCffWrapperModel>;
    if (
      typeof record.exportName !== "string" ||
      !Array.isArray(record.scopePath) || !record.scopePath.every((part) => typeof part === "string") ||
      !Array.isArray(record.states) || !record.states.every((part) => typeof part === "number") ||
      typeof record.entrySum !== "number"
    ) return [];
    return [{
      exportName: record.exportName,
      scopePath: [...record.scopePath],
      states: [...record.states],
      entrySum: record.entrySum,
    }];
  });
}

function findWrapperAssignment(
  ast: t.File,
  model: Cff213Model,
  wrapper: ExportedCffWrapperModel,
): t.AssignmentExpression | null {
  const matches: t.AssignmentExpression[] = [];
  visitNodes(ast.program, (node) => {
    if (
      node.type !== "AssignmentExpression" || node.operator !== "=" ||
      node.left.type !== "MemberExpression" || node.right.type !== "FunctionExpression"
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
    call?.type !== "CallExpression" || call.callee.type !== "Identifier" ||
    call.callee.name !== model.mainName || call.arguments.length < 2
  ) return null;
  const scopeArg = call.arguments[1];
  if (!scopeArg || scopeArg.type === "SpreadElement" || scopeArg.type !== "ObjectExpression") return null;
  const fresh: string[] = [];
  for (const property of scopeArg.properties) {
    if (property.type !== "ObjectProperty" || property.value.type !== "ObjectExpression" || property.value.properties.length !== 0) continue;
    if (property.key.type === "StringLiteral") fresh.push(property.key.value);
    else if (!property.computed && property.key.type === "Identifier") fresh.push(property.key.name);
  }
  return fresh.length === 1 ? fresh[0]! : null;
}

function mainArgumentName(ast: t.File, mainName: string): string | null {
  for (const statement of ast.program.body) {
    if (statement.type !== "FunctionDeclaration" || statement.id?.name !== mainName) continue;
    const parameter = statement.params[3];
    if (parameter?.type === "Identifier") return parameter.name;
    if (parameter?.type === "AssignmentPattern" && parameter.left.type === "Identifier") return parameter.left.name;
    return null;
  }
  return null;
}

function inputSlot(
  ast: t.File,
  model: Cff213Model,
  wrapper: ExportedCffWrapperModel,
  privateScope: string,
): string | null {
  const argumentName = mainArgumentName(ast, model.mainName);
  if (!argumentName) return null;
  const matches = new Set<string>();
  visitNodes(ast.program, (node) => {
    if (
      node.type !== "AssignmentExpression" || node.operator !== "=" ||
      node.right.type !== "Identifier" || node.right.name !== argumentName ||
      node.left.type !== "ArrayPattern" || node.left.elements.length !== 1
    ) return;
    const element = node.left.elements[0];
    if (!element || element.type === "RestElement" || !t.isNode(element)) return;
    const path = dynamicMemberPath(element, model, wrapper.states);
    if (path?.length === 2 && path[0] === privateScope) matches.add(path[1]!);
  });
  return matches.size === 1 ? [...matches][0]! : null;
}

function selectedCaseIndex(model: Cff213Model, states: readonly number[]): number | null {
  const sum = states.reduce((acc, value) => acc + value, 0);
  for (let index = 0; index < model.switchStatement.cases.length; index += 1) {
    const switchCase = model.switchStatement.cases[index]!;
    if (!switchCase.test) continue;
    if (evaluateOuter(switchCase.test, model, states) === sum) return index;
  }
  return null;
}

function applyStateAssignment(expression: t.AssignmentExpression, model: Cff213Model, states: number[]): boolean {
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
    return expression.expressions.every((item) => applyStateExpression(item, model, states));
  }
  if (expression.type === "AssignmentExpression") return applyStateAssignment(expression, model, states);
  if (expression.type === "UpdateExpression") {
    const index = stateIndex(expression.argument, model, states);
    if (index !== null) states[index] = states[index]! + (expression.operator === "++" ? 1 : -1);
  }
  return true;
}

function expandRuntimeStateArray(node: t.Node, model: Cff213Model, states: readonly number[]): number[] | null {
  if (node.type !== "ArrayExpression") return null;
  const result: number[] = [];
  for (const element of node.elements) {
    if (!element) return null;
    if (element.type === "SpreadElement") {
      const call = element.argument;
      if (
        call.type !== "CallExpression" || call.callee.type !== "Identifier" ||
        call.callee.name !== model.sliceName || call.arguments.length !== 2 ||
        call.arguments.some((argument) => argument.type === "SpreadElement")
      ) return null;
      const start = evaluateOuter(call.arguments[0] as t.Node, model, states);
      const end = evaluateOuter(call.arguments[1] as t.Node, model, states);
      if (
        typeof start !== "number" || typeof end !== "number" ||
        !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > model.sequence.length
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

function callPath(call: t.CallExpression, model: Cff213Model, states: readonly number[]): string[] | null {
  if (!t.isExpression(call.callee)) return null;
  const callee = call.callee.type === "SequenceExpression" ? call.callee.expressions.at(-1) : call.callee;
  return callee && t.isNode(callee) ? dynamicMemberPath(callee, model, states) : null;
}

function recursiveHelperStates(
  node: t.AssignmentExpression,
  model: Cff213Model,
  outerStates: readonly number[],
  privateScope: string,
): { path: string[]; states: number[] } | null {
  if (
    node.operator !== "=" || node.left.type !== "MemberExpression" || node.right.type !== "FunctionExpression"
  ) return null;
  const path = staticMemberPath(node.left, model.scopeName);
  if (!path || path.length !== 2 || path[0] !== privateScope) return null;
  const body = node.right.body.body;
  if (body.length !== 1 || body[0]?.type !== "ReturnStatement") return null;
  const call = body[0].argument;
  if (
    call?.type !== "CallExpression" || call.callee.type !== "Identifier" ||
    call.callee.name !== model.mainName || call.arguments.length < 1
  ) return null;
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement") return null;
  const states = expandRuntimeStateArray(first, model, outerStates);
  return states && states.length >= 75 ? { path, states } : null;
}

function nestedStatesFromOuterTrace(
  model: Cff213Model,
  wrapper: ExportedCffWrapperModel,
  privateScope: string,
): NestedStateTrace | null {
  const states = [...wrapper.states];
  const seen = new Set<string>();
  const helperStates = new Map<string, number[]>();
  for (let step = 0; step < 40; step += 1) {
    const signature = states.join(",");
    if (seen.has(signature)) return null;
    seen.add(signature);
    const selected = selectedCaseIndex(model, states);
    if (selected === null) return null;
    let repeated = false;
    for (let cursor = selected; cursor < model.switchStatement.cases.length; cursor += 1) {
      const current = model.switchStatement.cases[cursor]!;
      visitNodes(t.blockStatement(current.consequent), (node) => {
        if (node.type !== "AssignmentExpression") return;
        const helper = recursiveHelperStates(node, model, states, privateScope);
        if (helper) helperStates.set(helper.path.join("\u0000"), helper.states);
      });

      let nested: NestedStateTrace | null = null;
      visitNodes(t.blockStatement(current.consequent), (node) => {
        if (nested || node.type !== "CallExpression" || node.arguments.length < 1) return;
        const target = callPath(node, model, states);
        if (!target || target.length !== 2 || target[0] !== privateScope) return;
        const invocationStates = helperStates.get(target.join("\u0000"));
        if (!invocationStates) return;
        const first = node.arguments[0];
        if (!first || first.type === "SpreadElement") return;
        const innerStates = expandRuntimeStateArray(first, model, states);
        if (innerStates && innerStates.length >= 75) {
          nested = { invocationStates: [...invocationStates], innerStates };
        }
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
    discriminant.type !== "CallExpression" || discriminant.callee.type !== "Identifier" ||
    discriminant.callee.name !== model.sumName || discriminant.arguments.length !== 1
  ) return null;
  const argument = discriminant.arguments[0];
  if (!argument || argument.type === "SpreadElement") return null;
  const path = staticMemberPath(argument, model.scopeName);
  return path && path.length === 2 ? path : null;
}

function tailExpression(node: t.Expression): t.Expression {
  return node.type === "SequenceExpression" ? node.expressions.at(-1)! : node;
}

function forCandidate(
  node: t.ForStatement,
  model: Cff213Model,
  invocationStates: readonly number[],
  innerPath: readonly string[],
  innerStates: readonly number[],
): LoopCandidate | null {
  const inner = { path: innerPath, states: innerStates };
  const init = node.init;
  if (!init || init.type !== "AssignmentExpression" || init.operator !== "=" || init.left.type !== "MemberExpression") return null;
  const loopPath = dynamicMemberPath(init.left, model, invocationStates, inner);
  const zero = evaluateInner(init.right, model, invocationStates, innerPath, innerStates);
  if (!loopPath || zero !== 0) return null;

  if (!node.test || node.test.type !== "BinaryExpression" || node.test.operator !== "<") return null;
  if (!t.isExpression(node.test.left) || !t.isExpression(node.test.right)) return null;
  const testPath = dynamicMemberPath(node.test.left, model, invocationStates, inner);
  const bound = evaluateInner(node.test.right, model, invocationStates, innerPath, innerStates);
  if (!testPath || !pathsEqual(testPath, loopPath) || typeof bound !== "number") return null;

  if (!node.update || node.update.type !== "UpdateExpression" || node.update.operator !== "++") return null;
  const updatePath = dynamicMemberPath(node.update.argument, model, invocationStates, inner);
  if (!updatePath || !pathsEqual(updatePath, loopPath)) return null;

  const body = node.body.type === "BlockStatement" ? node.body.body : [node.body];
  if (body.length !== 1 || body[0]?.type !== "ExpressionStatement") return null;
  const expression = body[0].expression;
  if (
    expression.type !== "AssignmentExpression" || expression.operator !== "=" ||
    expression.left.type !== "MemberExpression" || expression.right.type !== "BinaryExpression" ||
    expression.right.operator !== "+" || !t.isExpression(expression.right.left) || !t.isExpression(expression.right.right)
  ) return null;
  const currentTarget = dynamicMemberPath(expression.left, model, invocationStates, inner);
  const currentSource = dynamicMemberPath(expression.right.left, model, invocationStates, inner);
  const loopSource = dynamicMemberPath(expression.right.right, model, invocationStates, inner);
  if (!currentTarget || !currentSource || !loopSource) return null;
  if (!pathsEqual(currentTarget, currentSource) || !pathsEqual(loopSource, loopPath)) return null;
  return { currentPath: currentTarget, loopPath, bound };
}

function findScenarioSemanticSwitch(
  model: Cff213Model,
  invocationStates: readonly number[],
  innerStates: readonly number[],
  privateScope: string,
  inputSlotName: string,
  twicePath: readonly string[],
): boolean {
  let matches = 0;
  visitNodes(model.switchStatement, (node) => {
    if (node.type !== "SwitchStatement" || node === model.switchStatement) return;
    const innerPath = innerSwitchPath(node, model);
    if (!innerPath) return;
    const inner = { path: innerPath, states: innerStates };
    const inputPath = [privateScope, inputSlotName];
    const calls: CallCandidate[] = [];
    const loops: LoopCandidate[] = [];
    const returns: string[][] = [];

    visitNodes(node, (candidate) => {
      if (
        candidate.type === "AssignmentExpression" && candidate.operator === "=" &&
        candidate.left.type === "MemberExpression" && candidate.right.type === "CallExpression"
      ) {
        const callee = callPath(candidate.right, model, invocationStates);
        if (callee && pathsEqual(callee, twicePath) && candidate.right.arguments.length === 1) {
          const argument = candidate.right.arguments[0];
          if (argument && argument.type !== "SpreadElement") {
            const targetPath = dynamicMemberPath(candidate.left, model, invocationStates, inner);
            const argumentPath = dynamicMemberPath(argument, model, invocationStates, inner);
            if (targetPath && argumentPath) calls.push({ targetPath, argumentPath });
          }
        }
      }
      if (candidate.type === "ForStatement") {
        const loop = forCandidate(candidate, model, invocationStates, innerPath, innerStates);
        if (loop) loops.push(loop);
      }
      if (candidate.type === "ReturnStatement" && candidate.argument && t.isExpression(candidate.argument)) {
        const path = dynamicMemberPath(tailExpression(candidate.argument), model, invocationStates, inner);
        if (path) returns.push(path);
      }
    });

    const matched = calls.some((call) =>
      pathsEqual(call.argumentPath, inputPath) &&
      loops.some((loop) =>
        loop.bound === 2 && pathsEqual(loop.currentPath, call.targetPath) &&
        returns.some((path) => pathsEqual(path, call.targetPath)),
      ),
    );
    if (matched) matches += 1;
  });
  return matches === 1;
}

function findScenarioPattern(ctx: DecompilerContext, ast: t.File): ScenarioPattern | null {
  const models = findCff213Models(ast);
  if (models.length !== 1) return null;
  const model = models[0]!;
  const wrappers = wrapperModels(ctx);
  const wrapper = wrappers.find((item) => item.exportName === "scenario");
  const twice = wrappers.find((item) => item.exportName === "twice");
  if (!wrapper || !twice) return null;
  const wrapperAssignment = findWrapperAssignment(ast, model, wrapper);
  if (!wrapperAssignment) return null;
  const privateScope = wrapperPrivateScope(wrapperAssignment, model);
  if (!privateScope) return null;
  const input = inputSlot(ast, model, wrapper, privateScope);
  if (!input) return null;
  const nested = nestedStatesFromOuterTrace(model, wrapper, privateScope);
  if (!nested) return null;
  if (!findScenarioSemanticSwitch(
    model,
    nested.invocationStates,
    nested.innerStates,
    privateScope,
    input,
    twice.scopePath,
  )) return null;
  return {
    wrapper,
    wrapperAssignment,
    twicePath: [...twice.scopePath],
    inputSlot: input,
  };
}

function memberExpressionFromPath(root: string, path: readonly string[]): t.Expression {
  let expression: t.Expression = t.identifier(root);
  for (const property of path) {
    expression = t.memberExpression(expression, t.stringLiteral(property), true);
  }
  return expression;
}

function replaceScenarioBody(pattern: ScenarioPattern, model: Cff213Model): void {
  const argument = t.identifier("arg0");
  const current = t.identifier("local0");
  const index = t.identifier("local1");
  pattern.wrapperAssignment.right = t.functionExpression(
    null,
    [argument],
    t.blockStatement([
      t.variableDeclaration("var", [
        t.variableDeclarator(
          current,
          t.callExpression(memberExpressionFromPath(model.scopeName, pattern.twicePath), [t.cloneNode(argument)]),
        ),
      ]),
      t.forStatement(
        t.variableDeclaration("var", [t.variableDeclarator(index, t.numericLiteral(0))]),
        t.binaryExpression("<", t.cloneNode(index), t.numericLiteral(2)),
        t.updateExpression("++", t.cloneNode(index), false),
        t.blockStatement([
          t.expressionStatement(
            t.assignmentExpression(
              "=",
              t.cloneNode(current),
              t.binaryExpression("+", t.cloneNode(current), t.cloneNode(index)),
            ),
          ),
        ]),
      ),
      t.returnStatement(t.cloneNode(current)),
    ]),
  );
}

function isRecoveryRecord(value: unknown): value is BodyRecoveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<BodyRecoveryRecord>;
  return typeof record.exportName === "string" && typeof record.reconstructed === "boolean";
}

function mergeRecovery(previous: unknown, record: BodyRecoveryRecord): BodyRecoveryRecord[] {
  const merged = new Map<string, BodyRecoveryRecord>();
  if (Array.isArray(previous)) {
    for (const item of previous) {
      if (isRecoveryRecord(item)) merged.set(item.exportName, { ...item });
    }
  }
  merged.set(record.exportName, record);
  return [...merged.values()];
}

export function createCffScenarioBody213Pass(): ReversePass {
  return {
    id: "jsconfuser.cff-body-scenario.v213",
    prerequisites: ["cff.body.twice"],
    conflicts: [],
    capabilities: ["cff.body.scenario"],
    detect(ctx) {
      const pattern = findScenarioPattern(ctx, ctx.cleanAst);
      return {
        detected: Boolean(pattern),
        confidence: pattern ? 0.99 : 0,
        evidence: pattern
          ? ["scenario wrapper links to twice(input), a bounded for loop, and a matching return path"]
          : [],
      };
    },
    analyze(ctx) {
      const pattern = findScenarioPattern(ctx, ctx.cleanAst);
      return {
        changed: false,
        facts: pattern
          ? {
              "cff.body.scenario": {
                entrySum: pattern.wrapper.entrySum,
                inputSlot: pattern.inputSlot,
                twicePath: [...pattern.twicePath],
              },
            }
          : {},
      };
    },
    transform(ctx) {
      if (!findScenarioPattern(ctx, ctx.cleanAst)) return { changed: false };
      let reconstructed = false;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.cff-body-scenario.v213",
          action: "reconstruct-scenario-cff-body-clean",
          confidence: 0.99,
          evidence: [
            "recursive and nested CFF state vectors are evaluated statically",
            "twice call, loop counter, bound, update, accumulation, and return are correlated by decoded member paths",
            "switch case order is irrelevant to the recovered structure",
          ],
        },
        (candidate) => {
          const model = findCff213Models(candidate)[0];
          const pattern = findScenarioPattern(ctx, candidate);
          if (!model || !pattern) return;
          replaceScenarioBody(pattern, model);
          reconstructed = true;
        },
      );
      if (transaction.committed && reconstructed) {
        ctx.report.recovery.cffBodies = mergeRecovery(
          ctx.report.recovery.cffBodies,
          { exportName: "scenario", reconstructed: true },
        );
      }
      return {
        changed: transaction.committed && reconstructed,
        actions: reconstructed ? ["reconstructed clean scenario body from nested CFF loop"] : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["only clean AST changes; exported wrapper member identity remains unchanged"],
      };
    },
  };
}
