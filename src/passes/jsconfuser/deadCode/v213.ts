import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { countNodes, rewriteNodes } from "../../rewrite.js";

const DUMMY_NAME = /^__p_[A-Za-z0-9]{4}_dummyFunction$/;
const DEAD_NAME = /^__p_[A-Za-z0-9]{4}_dead_\d+$/;

interface DeadCodePair {
  deadName: string;
  dummyName: string;
}

interface DeadCode213Model {
  dummyNames: Set<string>;
  pairs: DeadCodePair[];
}

function generatedEmptyDummy(node: t.Node): string | null {
  if (
    node.type !== "FunctionDeclaration" ||
    !node.id ||
    !DUMMY_NAME.test(node.id.name) ||
    node.params.length !== 0 ||
    node.body.body.length !== 0 ||
    node.async ||
    node.generator
  ) return null;
  return node.id.name;
}

function generatedDeadFunction(node: t.Node): string | null {
  if (
    node.type !== "FunctionDeclaration" ||
    !node.id ||
    !DEAD_NAME.test(node.id.name) ||
    node.params.length !== 0 ||
    node.async ||
    node.generator
  ) return null;
  return node.id.name;
}

function falsePredicateDummy(node: t.Node, dummyNames: ReadonlySet<string>): string | null {
  if (
    node.type !== "BinaryExpression" ||
    node.operator !== "in" ||
    node.left.type !== "StringLiteral" ||
    node.right.type !== "Identifier" ||
    !dummyNames.has(node.right.name)
  ) return null;
  return node.right.name;
}

function guardedDeadCall(
  node: t.Node,
  dummyNames: ReadonlySet<string>,
): DeadCodePair | null {
  if (node.type !== "IfStatement" || node.alternate) return null;
  const dummyName = falsePredicateDummy(node.test, dummyNames);
  if (!dummyName || node.consequent.type !== "BlockStatement" || node.consequent.body.length !== 1) {
    return null;
  }
  const statement = node.consequent.body[0];
  if (
    statement?.type !== "ExpressionStatement" ||
    statement.expression.type !== "CallExpression" ||
    statement.expression.callee.type !== "Identifier" ||
    !DEAD_NAME.test(statement.expression.callee.name) ||
    statement.expression.arguments.length !== 0
  ) return null;
  return { deadName: statement.expression.callee.name, dummyName };
}

export function findDeadCode213Model(ast: t.File): DeadCode213Model | null {
  const dummyNames = new Set<string>();
  const deadDeclarations = new Map<string, number>();
  const guards: DeadCodePair[] = [];

  rewriteNodes(ast, (node) => {
    const dummy = generatedEmptyDummy(node);
    if (dummy) dummyNames.add(dummy);
    const dead = generatedDeadFunction(node);
    if (dead) deadDeclarations.set(dead, (deadDeclarations.get(dead) ?? 0) + 1);
    return node;
  });
  if (dummyNames.size === 0 || deadDeclarations.size === 0) return null;

  rewriteNodes(ast, (node) => {
    const pair = guardedDeadCall(node, dummyNames);
    if (pair) guards.push(pair);
    return node;
  });

  const guardCounts = new Map<string, number>();
  for (const pair of guards) {
    guardCounts.set(pair.deadName, (guardCounts.get(pair.deadName) ?? 0) + 1);
  }

  const pairs = guards.filter(
    (pair) => deadDeclarations.get(pair.deadName) === 1 && guardCounts.get(pair.deadName) === 1,
  );
  return pairs.length > 0 ? { dummyNames, pairs } : null;
}

function removeDeadCode213(ast: t.File, model: DeadCode213Model): number {
  const removableDead = new Set(model.pairs.map((pair) => pair.deadName));
  const removableGuards = new Set(model.pairs.map((pair) => `${pair.dummyName}\u0000${pair.deadName}`));
  let changes = 0;

  rewriteNodes(ast, (node) => {
    const dead = generatedDeadFunction(node);
    if (dead && removableDead.has(dead)) {
      changes += 1;
      return t.emptyStatement();
    }

    const pair = guardedDeadCall(node, model.dummyNames);
    if (pair && removableGuards.has(`${pair.dummyName}\u0000${pair.deadName}`)) {
      changes += 1;
      return t.emptyStatement();
    }
    return node;
  });

  for (const dummyName of model.dummyNames) {
    const references = countNodes(
      ast,
      (node) => node.type === "Identifier" && node.name === dummyName,
    );
    if (references !== 1) continue;
    rewriteNodes(ast, (node) => {
      if (generatedEmptyDummy(node) === dummyName) {
        changes += 1;
        return t.emptyStatement();
      }
      return node;
    });
  }

  return changes;
}

export function createDeadCode213Pass(): ReversePass {
  return {
    id: "jsconfuser.dead-code.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["deadCode.reversed"],
    detect(ctx) {
      const model = findDeadCode213Model(ctx.safeAst);
      return {
        detected: Boolean(model),
        confidence: model ? 0.99 : 0,
        evidence: model
          ? [
              `${model.pairs.length} uniquely linked __p_XXXX_dead_N function/false-guard pair(s)`,
              "guards use PredicateGen string-in-empty-dummy false predicates",
            ]
          : [],
      };
    },
    analyze(ctx) {
      const model = findDeadCode213Model(ctx.safeAst);
      return {
        changed: false,
        facts: model
          ? {
              "deadCode.v213": model.pairs.map((pair) => ({ ...pair })),
            }
          : {},
      };
    },
    transform(ctx) {
      const model = findDeadCode213Model(ctx.safeAst);
      if (!model) return { changed: false };
      const evidence = [
        "generated dead function has exactly one matching generated false-guard call",
        "false guard is stringLiteral in an empty __p_XXXX_dummyFunction",
      ];
      let safeChanges = 0;
      let cleanChanges = 0;

      const safeTransaction = runAstTransaction(
        ctx,
        "safe",
        {
          passId: "jsconfuser.dead-code.v213",
          action: "remove-unreachable-generated-dead-code",
          confidence: 0.99,
          evidence,
        },
        (candidate) => {
          const candidateModel = findDeadCode213Model(candidate);
          if (candidateModel) safeChanges = removeDeadCode213(candidate, candidateModel);
        },
      );

      const cleanTransaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.dead-code.v213",
          action: "remove-unreachable-generated-dead-code",
          confidence: 0.99,
          evidence,
        },
        (candidate) => {
          const candidateModel = findDeadCode213Model(candidate);
          if (candidateModel) cleanChanges = removeDeadCode213(candidate, candidateModel);
        },
      );

      const changed =
        (safeTransaction.committed && safeChanges > 0) ||
        (cleanTransaction.committed && cleanChanges > 0);
      return {
        changed,
        actions: changed
          ? [`removed ${Math.max(safeChanges, cleanChanges)} generated dead-code nodes/scaffolds`]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["only uniquely paired generated false-guard/dead-function scaffolding is removed"],
      };
    },
  };
}
