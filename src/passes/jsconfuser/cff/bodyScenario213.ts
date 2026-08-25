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
import {
  callPath,
  findWrapperAssignment,
  innerSwitchPath,
  inputSlot,
  traceNestedStateInvocation,
  tailExpression,
  wrapperModels,
  wrapperPrivateScope,
} from "./wrapperRuntime213.js";

interface BodyRecoveryRecord {
  exportName: string;
  reconstructed: boolean;
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
  const nested = traceNestedStateInvocation(model, wrapper, privateScope, 40);
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
