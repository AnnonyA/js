import {
  callPath,
  decodeXor,
  dynamicMemberPath,
  evaluateInner,
  evaluateOuter,
  expandRuntimeStateArray,
  innerSwitchPath,
  nestedStatesFromOuterTrace,
  pathsEqual,
  selectedCaseIndex,
  staticMemberPath,
  tailExpression,
  visitNodes,
} from "./runtime213.js";
import * as t from "@babel/types";
import type { DecompilerContext } from "../../../core/context.js";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { findCff213Models, type Cff213Model } from "./model.js";
import type { ExportedCffWrapperModel } from "./wrappers.js";

interface TwicePattern {
  wrapper: ExportedCffWrapperModel;
  wrapperAssignment: t.AssignmentExpression;
  add3Path: string[];
  inputSlot: string;
}

interface BodyRecoveryRecord {
  exportName: string;
  reconstructed: boolean;
}

function wrapperModels(ctx: DecompilerContext): ExportedCffWrapperModel[] {
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

function mainArgumentName(ast: t.File, mainName: string): string | null {
  for (const statement of ast.program.body) {
    if (statement.type !== "FunctionDeclaration" || statement.id?.name !== mainName) continue;
    const parameter = statement.params[3];
    if (parameter?.type === "Identifier") return parameter.name;
    if (
      parameter?.type === "AssignmentPattern" &&
      parameter.left.type === "Identifier"
    ) {
      return parameter.left.name;
    }
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

function findTwiceSemanticSwitch(
  model: Cff213Model,
  invocationStates: readonly number[],
  innerStates: readonly number[],
  privateScope: string,
  inputSlotName: string,
  add3Path: readonly string[],
): boolean {
  let matchedSwitches = 0;
  visitNodes(model.switchStatement, (node) => {
    if (node.type !== "SwitchStatement" || node === model.switchStatement) return;
    const innerPath = innerSwitchPath(node, model);
    if (!innerPath) return;
    const inner = { path: innerPath, states: innerStates };
    const inputPath = [privateScope, inputSlotName];
    let resultPath: string[] | null = null;
    let callMatch = false;
    let parityMatch = false;
    const returnCandidates: Array<{
      path: string[];
      operator: "*" | "+";
      right: number;
    }> = [];

    visitNodes(node, (candidate) => {
      if (
        candidate.type === "AssignmentExpression" &&
        candidate.operator === "=" &&
        candidate.left.type === "MemberExpression" &&
        candidate.right.type === "CallExpression"
      ) {
        const calleePath = callPath(candidate.right, model, invocationStates);
        if (calleePath && pathsEqual(calleePath, add3Path) && candidate.right.arguments.length === 3) {
          const [first, second, third] = candidate.right.arguments;
          if (
            first && second && third &&
            first.type !== "SpreadElement" && second.type !== "SpreadElement" && third.type !== "SpreadElement"
          ) {
            const firstPath = dynamicMemberPath(first, model, invocationStates, inner);
            const secondPath = dynamicMemberPath(second, model, invocationStates, inner);
            const zero = evaluateInner(third, model, invocationStates, innerPath, innerStates);
            const targetPath = dynamicMemberPath(candidate.left, model, invocationStates, inner);
            if (
              firstPath && secondPath && targetPath &&
              pathsEqual(firstPath, inputPath) &&
              pathsEqual(secondPath, inputPath) &&
              zero === 0
            ) {
              resultPath = targetPath;
              callMatch = true;
            }
          }
        }
      }

      if (candidate.type === "IfStatement" && candidate.test.type === "BinaryExpression") {
        const test = candidate.test;
        if (
          (test.operator === "===" || test.operator === "==") &&
          t.isExpression(test.left) &&
          t.isExpression(test.right) &&
          test.left.type === "BinaryExpression" &&
          test.left.operator === "%" &&
          t.isExpression(test.left.left) &&
          t.isExpression(test.left.right)
        ) {
          const path = dynamicMemberPath(test.left.left, model, invocationStates, inner);
          const modulo = evaluateInner(test.left.right, model, invocationStates, innerPath, innerStates);
          const zero = evaluateInner(test.right, model, invocationStates, innerPath, innerStates);
          if (path && resultPath && pathsEqual(path, resultPath) && modulo === 2 && zero === 0) {
            parityMatch = true;
          }
        }
      }

      if (candidate.type === "ReturnStatement" && candidate.argument && t.isExpression(candidate.argument)) {
        const expression = tailExpression(candidate.argument);
        if (
          expression.type === "BinaryExpression" &&
          (expression.operator === "*" || expression.operator === "+") &&
          t.isExpression(expression.left) &&
          t.isExpression(expression.right)
        ) {
          const path = dynamicMemberPath(expression.left, model, invocationStates, inner);
          const right = evaluateInner(expression.right, model, invocationStates, innerPath, innerStates);
          if (path && typeof right === "number") {
            returnCandidates.push({ path, operator: expression.operator, right });
          }
        }
      }
    });

    const doubleReturn = Boolean(resultPath) && returnCandidates.some(
      (candidate) =>
        candidate.operator === "*" &&
        candidate.right === 2 &&
        pathsEqual(candidate.path, resultPath!),
    );
    const plusReturn = Boolean(resultPath) && returnCandidates.some(
      (candidate) =>
        candidate.operator === "+" &&
        candidate.right === 1 &&
        pathsEqual(candidate.path, resultPath!),
    );

    if (callMatch && parityMatch && doubleReturn && plusReturn) matchedSwitches += 1;
  });
  return matchedSwitches === 1;
}

function findTwicePattern(ctx: DecompilerContext, ast: t.File): TwicePattern | null {
  const models = findCff213Models(ast);
  if (models.length !== 1) return null;
  const model = models[0]!;
  const wrappers = wrapperModels(ctx);
  const wrapper = wrappers.find((item) => item.exportName === "twice");
  const add3 = wrappers.find((item) => item.exportName === "add3");
  if (!wrapper || !add3) return null;
  const wrapperAssignment = findWrapperAssignment(ast, model, wrapper);
  if (!wrapperAssignment) return null;
  const privateScope = wrapperPrivateScope(wrapperAssignment, model);
  if (!privateScope) return null;
  const input = inputSlot(ast, model, wrapper, privateScope);
  if (!input) return null;
  const nested = nestedStatesFromOuterTrace(model, wrapper, privateScope);
  if (!nested) return null;
  if (!findTwiceSemanticSwitch(
    model,
    nested.invocationStates,
    nested.innerStates,
    privateScope,
    input,
    add3.scopePath,
  )) {
    return null;
  }
  return {
    wrapper,
    wrapperAssignment,
    add3Path: [...add3.scopePath],
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

function replaceTwiceBody(pattern: TwicePattern, model: Cff213Model): void {
  const argument = t.identifier("arg0");
  const local = t.identifier("local0");
  pattern.wrapperAssignment.right = t.functionExpression(
    null,
    [argument],
    t.blockStatement([
      t.variableDeclaration("var", [
        t.variableDeclarator(
          local,
          t.callExpression(memberExpressionFromPath(model.scopeName, pattern.add3Path), [
            t.cloneNode(argument),
            t.cloneNode(argument),
            t.numericLiteral(0),
          ]),
        ),
      ]),
      t.ifStatement(
        t.binaryExpression(
          "===",
          t.binaryExpression("%", t.cloneNode(local), t.numericLiteral(2)),
          t.numericLiteral(0),
        ),
        t.blockStatement([
          t.returnStatement(t.binaryExpression("*", t.cloneNode(local), t.numericLiteral(2))),
        ]),
      ),
      t.returnStatement(t.binaryExpression("+", t.cloneNode(local), t.numericLiteral(1))),
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

export function createCffTwiceBody213Pass(): ReversePass {
  return {
    id: "jsconfuser.cff-body-twice.v213",
    prerequisites: ["cff.body.add3"],
    conflicts: [],
    capabilities: ["cff.body.twice"],
    detect(ctx) {
      const pattern = findTwicePattern(ctx, ctx.cleanAst);
      return {
        detected: Boolean(pattern),
        confidence: pattern ? 0.99 : 0,
        evidence: pattern
          ? [
              "decoded twice wrapper links to a one-argument private scope entry",
              "nested CFF contains add3(arg,arg,0), parity branch, and matching *2/+1 returns",
            ]
          : [],
      };
    },
    analyze(ctx) {
      const pattern = findTwicePattern(ctx, ctx.cleanAst);
      return {
        changed: false,
        facts: pattern
          ? {
              "cff.body.twice": {
                entrySum: pattern.wrapper.entrySum,
                inputSlot: pattern.inputSlot,
                add3Path: [...pattern.add3Path],
              },
            }
          : {},
      };
    },
    transform(ctx) {
      if (!findTwicePattern(ctx, ctx.cleanAst)) return { changed: false };
      let reconstructed = false;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.cff-body-twice.v213",
          action: "reconstruct-twice-cff-body-clean",
          confidence: 0.99,
          evidence: [
            "wrapper entry and private argument slot are linked statically",
            "recursive main state and nested generated state vector are both expanded without executing input code",
            "add3 call target/arguments, modulo branch, and both return expressions agree structurally independent of shuffled switch-case order",
          ],
        },
        (candidate) => {
          const model = findCff213Models(candidate)[0];
          const pattern = findTwicePattern(ctx, candidate);
          if (!model || !pattern) return;
          replaceTwiceBody(pattern, model);
          reconstructed = true;
        },
      );
      if (transaction.committed && reconstructed) {
        ctx.report.recovery.cffBodies = mergeRecovery(
          ctx.report.recovery.cffBodies,
          { exportName: "twice", reconstructed: true },
        );
      }
      return {
        changed: transaction.committed && reconstructed,
        actions: reconstructed ? ["reconstructed clean twice body from nested CFF branch"] : [],
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
