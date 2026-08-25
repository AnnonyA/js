import * as t from "@babel/types";
import { evaluateConstant } from "../../../analysis/constants/index.js";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { countNodes, rewriteNodes } from "../../rewrite.js";

interface DuplicateLiteralModel {
  name: string;
  values: t.Expression[];
}

interface RecoveryStats {
  found: number;
  recovered: number;
  tablesRemoved: number;
}

function staticLiteral(element: t.ArrayExpression["elements"][number]): t.Expression | null {
  if (!element || element.type === "SpreadElement") return null;
  if (
    element.type === "StringLiteral" ||
    element.type === "NumericLiteral" ||
    element.type === "BooleanLiteral" ||
    element.type === "NullLiteral"
  ) {
    return element;
  }
  if (element.type === "Identifier" && element.name === "undefined") {
    return element;
  }
  if (
    element.type === "UnaryExpression" &&
    (element.operator === "+" || element.operator === "-") &&
    element.argument.type === "NumericLiteral"
  ) {
    return element;
  }
  return null;
}

function findModels(ast: t.File): DuplicateLiteralModel[] {
  const models: DuplicateLiteralModel[] = [];
  rewriteNodes(ast, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.id.type !== "Identifier" ||
      !node.id.name.endsWith("_dlrArray") ||
      node.init?.type !== "ArrayExpression" ||
      node.init.elements.length === 0
    ) {
      return node;
    }

    const values = node.init.elements.map(staticLiteral);
    if (values.some((value) => value === null)) return node;
    models.push({
      name: node.id.name,
      values: values as t.Expression[],
    });
    return node;
  });
  return models;
}

function staticIndex(node: t.Expression | t.PrivateName): number | null {
  if (node.type === "PrivateName") return null;
  const result = evaluateConstant({ node });
  if (
    !result.confident ||
    typeof result.value !== "number" ||
    !Number.isInteger(result.value) ||
    result.value < 0
  ) {
    return null;
  }
  return result.value;
}

function removeUnusedTables(
  ast: t.File,
  models: readonly DuplicateLiteralModel[],
): number {
  const removable = new Set(
    models
      .filter(
        (model) =>
          countNodes(
            ast,
            (node) => node.type === "Identifier" && node.name === model.name,
          ) <= 1,
      )
      .map((model) => model.name),
  );
  if (removable.size === 0) return 0;

  let removed = 0;
  rewriteNodes(ast, (node) => {
    if (node.type !== "Program" && node.type !== "BlockStatement") return node;
    node.body = node.body.filter((statement) => {
      if (statement.type !== "VariableDeclaration") return true;
      statement.declarations = statement.declarations.filter((declaration) => {
        if (
          declaration.id.type === "Identifier" &&
          removable.has(declaration.id.name)
        ) {
          removed += 1;
          return false;
        }
        return true;
      });
      return statement.declarations.length > 0;
    });
    return node;
  });
  return removed;
}

function recoverDuplicateLiterals(ast: t.File): RecoveryStats {
  const models = findModels(ast);
  const byName = new Map(models.map((model) => [model.name, model]));
  let found = 0;
  let recovered = 0;

  rewriteNodes(ast, (node) => {
    if (
      node.type !== "MemberExpression" ||
      !node.computed ||
      node.object.type !== "Identifier"
    ) {
      return node;
    }
    const model = byName.get(node.object.name);
    if (!model) return node;
    found += 1;

    const index = staticIndex(node.property);
    if (index === null || index >= model.values.length) return node;
    recovered += 1;
    return t.cloneNode(model.values[index]!, true);
  });

  return {
    found,
    recovered,
    tablesRemoved: removeUnusedTables(ast, models),
  };
}

export function createDuplicateLiterals213Pass(): ReversePass {
  return {
    id: "jsconfuser.duplicate-literals.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["duplicate-literals.reversed"],
    detect(ctx) {
      const models = findModels(t.cloneNode(ctx.cleanAst, true));
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.99 : 0,
        evidence:
          models.length > 0
            ? [`${models.length} generated *_dlrArray literal tables`]
            : [],
      };
    },
    analyze(ctx) {
      const models = findModels(t.cloneNode(ctx.cleanAst, true));
      return {
        changed: false,
        facts: {
          "duplicateLiterals.tables": models.map((model) => ({
            name: model.name,
            size: model.values.length,
          })),
        },
      };
    },
    transform(ctx) {
      if (findModels(t.cloneNode(ctx.cleanAst, true)).length === 0) {
        return { changed: false };
      }

      let safeStats: RecoveryStats | null = null;
      let cleanStats: RecoveryStats | null = null;
      const safeTransaction = runAstTransaction(
        ctx,
        "safe",
        {
          passId: "jsconfuser.duplicate-literals.v213",
          action: "restore-static-duplicate-literals-safe",
          confidence: 0.99,
          evidence: ["generated literal table with static indices"],
        },
        (candidate) => {
          safeStats = recoverDuplicateLiterals(candidate);
        },
      );
      const cleanTransaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.duplicate-literals.v213",
          action: "restore-static-duplicate-literals-clean",
          confidence: 0.99,
          evidence: ["generated literal table with static indices"],
        },
        (candidate) => {
          cleanStats = recoverDuplicateLiterals(candidate);
        },
      );

      const safeChanged =
        safeTransaction.committed && (safeStats as RecoveryStats | null)?.recovered;
      const cleanChanged =
        cleanTransaction.committed && (cleanStats as RecoveryStats | null)?.recovered;
      const stats = cleanStats as RecoveryStats | null;

      return {
        changed: Boolean(safeChanged || cleanChanged),
        actions: stats
          ? [
              `restored ${stats.recovered}/${stats.found} duplicate literal reads`,
              `removed ${stats.tablesRemoved} unused literal tables`,
            ]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["static table lookup and transactional syntax validation"],
      };
    },
  };
}
