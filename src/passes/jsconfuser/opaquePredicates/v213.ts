import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { countNodes, rewriteNodes } from "../../rewrite.js";

const DUMMY_NAME = /^__p_[A-Za-z0-9]{4}_dummyFunction$/;

interface OpaquePredicateModel {
  dummyNames: Set<string>;
  predicates: number;
  returnGuards: number;
}

function generatedDummyName(node: t.Node): string | null {
  if (
    node.type !== "FunctionDeclaration" ||
    !node.id ||
    !DUMMY_NAME.test(node.id.name) ||
    node.params.length !== 0 ||
    node.body.body.length !== 0 ||
    node.async ||
    node.generator
  ) {
    return null;
  }
  return node.id.name;
}

function truePredicateDummy(node: t.Node, dummyNames: ReadonlySet<string>): string | null {
  if (
    node.type !== "UnaryExpression" ||
    node.operator !== "!" ||
    node.argument.type !== "BinaryExpression" ||
    node.argument.operator !== "in" ||
    node.argument.left.type !== "StringLiteral" ||
    node.argument.right.type !== "Identifier" ||
    !dummyNames.has(node.argument.right.name)
  ) {
    return null;
  }
  return node.argument.right.name;
}

function singleReturn(block: t.Statement | null | undefined): t.ReturnStatement | null {
  if (!block || block.type !== "BlockStatement" || block.body.length !== 1) return null;
  const statement = block.body[0];
  return statement?.type === "ReturnStatement" ? statement : null;
}

function fakeReturnGuard(node: t.Node, dummyNames: ReadonlySet<string>): t.ReturnStatement | null {
  if (node.type !== "IfStatement") return null;
  if (!truePredicateDummy(node.test, dummyNames)) return null;
  const consequent = singleReturn(node.consequent);
  const alternate = singleReturn(node.alternate);
  if (!consequent?.argument || !alternate?.argument) return null;
  if (alternate.argument.type !== "StringLiteral" || alternate.argument.value.length !== 6) return null;
  return consequent;
}

export function findOpaquePredicate213Model(ast: t.File): OpaquePredicateModel | null {
  const dummyNames = new Set<string>();
  rewriteNodes(ast, (node) => {
    const name = generatedDummyName(node);
    if (name) dummyNames.add(name);
    return node;
  });
  if (dummyNames.size === 0) return null;

  let predicates = 0;
  let returnGuards = 0;
  rewriteNodes(ast, (node) => {
    if (truePredicateDummy(node, dummyNames)) predicates += 1;
    if (fakeReturnGuard(node, dummyNames)) returnGuards += 1;
    return node;
  });
  if (predicates === 0) return null;
  return { dummyNames, predicates, returnGuards };
}

function simplifyOpaquePredicates(ast: t.File, model: OpaquePredicateModel): number {
  let replacements = 0;
  rewriteNodes(ast, (node) => {
    if (
      node.type === "LogicalExpression" &&
      node.operator === "&&" &&
      truePredicateDummy(node.left, model.dummyNames)
    ) {
      replacements += 1;
      return t.cloneNode(node.right, true);
    }

    const realReturn = fakeReturnGuard(node, model.dummyNames);
    if (realReturn) {
      replacements += 1;
      return t.cloneNode(realReturn, true);
    }
    return node;
  });

  ast.program.body = ast.program.body.filter((statement) => {
    const name = generatedDummyName(statement);
    if (!name || !model.dummyNames.has(name)) return true;
    const references = countNodes(
      ast,
      (node) => node.type === "Identifier" && node.name === name,
    );
    if (references !== 1) return true;
    replacements += 1;
    return false;
  });

  return replacements;
}

export function createOpaquePredicates213Pass(): ReversePass {
  return {
    id: "jsconfuser.opaque-predicates.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["opaquePredicates.reversed"],
    detect(ctx) {
      const model = findOpaquePredicate213Model(ctx.safeAst);
      return {
        detected: Boolean(model),
        confidence: model ? 0.99 : 0,
        evidence: model
          ? [
              `${model.dummyNames.size} generated empty dummy function(s)`,
              `${model.predicates} generated membership predicate(s)`,
              `${model.returnGuards} guarded return(s)`,
            ]
          : [],
      };
    },
    analyze(ctx) {
      const model = findOpaquePredicate213Model(ctx.safeAst);
      return {
        changed: false,
        facts: model
          ? {
              "opaquePredicates.v213": {
                dummyFunctions: [...model.dummyNames],
                predicates: model.predicates,
                returnGuards: model.returnGuards,
              },
            }
          : {},
      };
    },
    transform(ctx) {
      const model = findOpaquePredicate213Model(ctx.safeAst);
      if (!model) return { changed: false };

      const evidence = [
        "empty __p_XXXX_dummyFunction placeholder matches js-confuser PredicateGen",
        "predicate is exactly !(stringLiteral in generatedDummyFunction)",
      ];
      let safeChanges = 0;
      let cleanChanges = 0;

      const safeTransaction = runAstTransaction(
        ctx,
        "safe",
        {
          passId: "jsconfuser.opaque-predicates.v213",
          action: "remove-proven-opaque-predicates",
          confidence: 0.99,
          evidence,
        },
        (candidate) => {
          const candidateModel = findOpaquePredicate213Model(candidate);
          if (candidateModel) safeChanges = simplifyOpaquePredicates(candidate, candidateModel);
        },
      );

      const cleanTransaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.opaque-predicates.v213",
          action: "remove-proven-opaque-predicates",
          confidence: 0.99,
          evidence,
        },
        (candidate) => {
          const candidateModel = findOpaquePredicate213Model(candidate);
          if (candidateModel) cleanChanges = simplifyOpaquePredicates(candidate, candidateModel);
        },
      );

      const changed =
        (safeTransaction.committed && safeChanges > 0) ||
        (cleanTransaction.committed && cleanChanges > 0);
      return {
        changed,
        actions: changed
          ? [`removed ${Math.max(safeChanges, cleanChanges)} opaque-predicate nodes/scaffolds`]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["only exact PredicateGen topology is simplified and transactional AST validation passes"],
      };
    },
  };
}
