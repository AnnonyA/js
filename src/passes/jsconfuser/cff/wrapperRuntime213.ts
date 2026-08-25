import * as t from "@babel/types";
import type { DecompilerContext } from "../../../core/context.js";
import type { Cff213Model } from "./model.js";
import {
  UNKNOWN,
  applyStateExpression,
  dynamicMemberPath,
  evaluateOuter,
  expandRuntimeStateArray,
  pathsEqual,
  selectedCaseIndex,
  staticMemberPath,
  visitNodes,
} from "./runtime213.js";
import type { ExportedCffWrapperModel } from "./wrappers.js";

export interface NestedStateTrace {
  invocationStates: number[];
  innerStates: number[];
}

export function wrapperModels(ctx: DecompilerContext): ExportedCffWrapperModel[] {
  const value = ctx.facts.get("cff.exportedWrappers");
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<ExportedCffWrapperModel>;
    if (
      typeof record.exportName !== "string" ||
      !Array.isArray(record.scopePath) ||
      !record.scopePath.every((part) => typeof part === "string") ||
      !Array.isArray(record.states) ||
      !record.states.every((part) => typeof part === "number") ||
      typeof record.entrySum !== "number"
    ) {
      return [];
    }
    return [{
      exportName: record.exportName,
      scopePath: [...record.scopePath],
      states: [...record.states],
      entrySum: record.entrySum,
    }];
  });
}

export function findWrapperAssignment(
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

export function wrapperPrivateScope(
  assignment: t.AssignmentExpression,
  model: Cff213Model,
): string | null {
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

export function mainArgumentName(ast: t.File, mainName: string): string | null {
  for (const statement of ast.program.body) {
    if (statement.type !== "FunctionDeclaration" || statement.id?.name !== mainName) continue;
    const parameter = statement.params[3];
    if (parameter?.type === "Identifier") return parameter.name;
    if (parameter?.type === "AssignmentPattern" && parameter.left.type === "Identifier") {
      return parameter.left.name;
    }
    return null;
  }
  return null;
}

export function inputSlot(
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
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.right.type !== "Identifier" ||
      node.right.name !== argumentName ||
      node.left.type !== "ArrayPattern" ||
      node.left.elements.length !== 1
    ) return;
    const element = node.left.elements[0];
    if (!element || element.type === "RestElement" || !t.isNode(element)) return;
    const path = dynamicMemberPath(element, model, wrapper.states);
    if (path?.length === 2 && path[0] === privateScope) matches.add(path[1]!);
  });
  return matches.size === 1 ? [...matches][0]! : null;
}

export function callPath(
  call: t.CallExpression,
  model: Cff213Model,
  states: readonly number[],
): string[] | null {
  if (!t.isExpression(call.callee)) return null;
  const callee = call.callee.type === "SequenceExpression"
    ? call.callee.expressions.at(-1)
    : call.callee;
  return callee && t.isNode(callee) ? dynamicMemberPath(callee, model, states) : null;
}

function recursiveHelperStates(
  node: t.AssignmentExpression,
  model: Cff213Model,
  outerStates: readonly number[],
  privateScope: string,
): { path: string[]; states: number[] } | null {
  if (
    node.operator !== "=" ||
    node.left.type !== "MemberExpression" ||
    node.right.type !== "FunctionExpression"
  ) return null;
  const path = staticMemberPath(node.left, model.scopeName);
  if (!path || path.length !== 2 || path[0] !== privateScope) return null;
  const body = node.right.body.body;
  if (body.length !== 1 || body[0]?.type !== "ReturnStatement") return null;
  const call = body[0].argument;
  if (
    call?.type !== "CallExpression" ||
    call.callee.type !== "Identifier" ||
    call.callee.name !== model.mainName ||
    call.arguments.length < 1
  ) return null;
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement") return null;
  const states = expandRuntimeStateArray(first, model, outerStates);
  return states && states.length >= 75 ? { path, states } : null;
}

export function traceNestedStateInvocation(
  model: Cff213Model,
  wrapper: ExportedCffWrapperModel,
  privateScope: string,
  maxSteps: number,
): NestedStateTrace | null {
  const states = [...wrapper.states];
  const seen = new Set<string>();
  const helperStates = new Map<string, number[]>();
  for (let step = 0; step < maxSteps; step += 1) {
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
          nested = {
            invocationStates: [...invocationStates],
            innerStates,
          };
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

export function innerSwitchPath(node: t.SwitchStatement, model: Cff213Model): string[] | null {
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

export function tailExpression(node: t.Expression): t.Expression {
  return node.type === "SequenceExpression" ? node.expressions.at(-1)! : node;
}
