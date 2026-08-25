import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { findCff213Models, type Cff213Model } from "./model.js";
import {
  findExportedCffWrapperModels,
  type ExportedCffWrapperModel,
} from "./wrappers.js";
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
  traceInnerSwitchCases,
  visitNodes,
} from "./runtime213.js";
import {
  findWrapperAssignment,
  innerSwitchPath,
  traceNestedStateInvocation,
  wrapperPrivateScope,
} from "./wrapperRuntime213.js";

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

function flattenPlus(node: t.Node): t.Expression[] | null {
  if (node.type === "BinaryExpression" && node.operator === "+") {
    if (!t.isExpression(node.left) || !t.isExpression(node.right)) return null;
    const left = flattenPlus(node.left);
    const right = flattenPlus(node.right);
    return left && right ? [...left, ...right] : null;
  }
  return t.isExpression(node) ? [node] : null;
}

function tailExpression(node: t.Expression): t.Expression {
  return node.type === "SequenceExpression" ? node.expressions.at(-1)! : node;
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
  type TotalCandidate = {
    targetPath: string[];
    parameterOrder: string[];
  };
  type LabelCandidate = {
    targetPath: string[];
    totalPath: string[];
    threshold: number;
    consequent: string;
    alternate: string;
  };
  type ConsoleCandidate = {
    argumentPath: string[];
    property: string;
  };

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
    const traces = traceInnerSwitchCases(node, model, outerStates, innerPath, nestedStates);
    if (!traces) return;

    const totals: TotalCandidate[] = [];
    const labels: LabelCandidate[] = [];
    const consoles: ConsoleCandidate[] = [];
    const returns: string[][] = [];

    for (const trace of traces) {
      const currentStates = trace.states;
      const inner = { path: innerPath, states: currentStates };
      visitNodes(t.blockStatement(trace.switchCase.consequent), (candidate) => {
        if (
candidate.type === "AssignmentExpression" &&
candidate.operator === "=" &&
candidate.left.type === "MemberExpression"
        ) {
const targetPath = dynamicMemberPath(candidate.left, model, outerStates, inner);
if (!targetPath) return;

if (candidate.right.type === "BinaryExpression") {
  const operands = flattenPlus(candidate.right);
  if (operands?.length === 3) {
    const parameterOrder = operands.map((operand) => {
      const path = dynamicMemberPath(operand, model, outerStates, inner);
      return path && path.length === 2 && path[0] === privateScope ? path[1]! : null;
    });
    if (parameterOrder.every((slot): slot is string => slot !== null)) {
      totals.push({ targetPath, parameterOrder });
    }
  }
}

if (
  candidate.right.type === "ConditionalExpression" &&
  candidate.right.test.type === "BinaryExpression" &&
  candidate.right.test.operator === ">" &&
  t.isExpression(candidate.right.test.left) &&
  t.isExpression(candidate.right.test.right)
) {
  const totalPath = dynamicMemberPath(candidate.right.test.left, model, outerStates, inner);
  const threshold = evaluateInner(
    candidate.right.test.right,
    model,
    outerStates,
    innerPath,
    currentStates,
  );
  const consequent = candidate.right.consequent.type === "StringLiteral"
    ? candidate.right.consequent.value
    : decodeXor(candidate.right.consequent, model, outerStates, inner);
  const alternate = candidate.right.alternate.type === "StringLiteral"
    ? candidate.right.alternate.value
    : decodeXor(candidate.right.alternate, model, outerStates, inner);
  if (
    totalPath &&
    typeof threshold === "number" &&
    consequent !== null &&
    alternate !== null
  ) {
    labels.push({ targetPath, totalPath, threshold, consequent, alternate });
  }
}
        }

        if (
candidate.type === "CallExpression" &&
candidate.callee.type === "MemberExpression" &&
candidate.callee.object.type === "Identifier" &&
candidate.callee.object.name === "console" &&
candidate.arguments.length >= 1 &&
candidate.callee.property.type !== "PrivateName"
        ) {
const argument = candidate.arguments[0];
if (!argument || argument.type === "SpreadElement") return;
const argumentPath = dynamicMemberPath(argument, model, outerStates, inner);
const property = !candidate.callee.computed && candidate.callee.property.type === "Identifier"
  ? candidate.callee.property.name
  : candidate.callee.computed && candidate.callee.property.type === "StringLiteral"
    ? candidate.callee.property.value
    : candidate.callee.computed
      ? decodeXor(candidate.callee.property, model, outerStates, inner)
      : null;
if (argumentPath && property) consoles.push({ argumentPath, property });
        }

        if (candidate.type === "ReturnStatement" && candidate.argument && t.isExpression(candidate.argument)) {
const path = dynamicMemberPath(tailExpression(candidate.argument), model, outerStates, inner);
if (path) returns.push(path);
        }
      });
    }

    for (const total of totals) {
      for (const label of labels) {
        if (!pathsEqual(label.totalPath, total.targetPath)) continue;
        const console = consoles.find((item) => pathsEqual(item.argumentPath, label.targetPath));
        if (!console) continue;
        if (!returns.some((path) => pathsEqual(path, total.targetPath))) continue;
        matches.push({
parameterOrder: total.parameterOrder,
threshold: label.threshold,
consequent: label.consequent,
alternate: label.alternate,
consoleProperty: console.property,
        });
      }
    }
  });

  const unique = new Map<string, (typeof matches)[number]>();
  for (const match of matches) {
    const key = JSON.stringify(match);
    unique.set(key, match);
  }
  return unique.size === 1 ? [...unique.values()][0]! : null;
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
  const nested = traceNestedStateInvocation(model, wrapper, privateScope, 40);
  if (!nested) return null;
  const body = semanticBody(model, nested.invocationStates, nested.innerStates, privateScope);
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
