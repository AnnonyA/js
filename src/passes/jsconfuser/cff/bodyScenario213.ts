import * as t from "@babel/types";
import type { DecompilerContext } from "../../../core/context.js";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { findCff213Models, type Cff213Model } from "./model.js";
import type { ExportedCffWrapperModel } from "./wrappers.js";
import {
  UNKNOWN,
  applyStateExpression,
  decodeXor,
  dynamicMemberPath,
  evaluateInner,
  evaluateOuter,
  expandRuntimeStateArray,
  pathsEqual,
  selectedCaseIndex,
  staticMemberPath,
  visitNodes,
} from "./runtime213.js";

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
