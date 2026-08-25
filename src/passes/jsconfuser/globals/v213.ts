import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { countNodes, rewriteNodes } from "../../rewrite.js";
import {
  findGlobalConcealingModels,
  type GlobalConcealingModel,
} from "./model.js";

interface RecoveryStats {
  replacements: number;
  helpersRemoved: number;
  scaffoldingRemoved: number;
}

function countIdentifier(ast: t.File, name: string): number {
  return countNodes(
    ast,
    (node) => node.type === "Identifier" && node.name === name,
  );
}

function recoverGlobalConcealing(
  ast: t.File,
  models: readonly GlobalConcealingModel[],
): RecoveryStats {
  const byFunction = new Map(models.map((model) => [model.functionName, model]));
  let replacements = 0;

  rewriteNodes(ast, (node) => {
    if (node.type !== "CallExpression") return node;
    if (node.callee.type !== "Identifier") return node;
    const model = byFunction.get(node.callee.name);
    if (!model || node.arguments.length !== 1) return node;
    const selector = node.arguments[0];
    if (selector?.type !== "StringLiteral") return node;
    const globalName = model.mappings.get(selector.value);
    if (!globalName || !t.isValidIdentifier(globalName)) return node;
    replacements += 1;
    return t.identifier(globalName);
  });

  let helpersRemoved = 0;
  const helperNames = new Set(models.map((model) => model.functionName));
  ast.program.body = ast.program.body.filter((statement) => {
    if (statement.type !== "FunctionDeclaration" || !statement.id) return true;
    if (!helperNames.has(statement.id.name)) return true;
    if (countIdentifier(ast, statement.id.name) > 1) return true;
    helpersRemoved += 1;
    return false;
  });

  let scaffoldingRemoved = 0;
  for (const model of models) {
    if (countIdentifier(ast, model.globalVarName) === 1) {
      ast.program.body = ast.program.body.filter((statement) => {
        if (statement.type !== "VariableDeclaration") return true;
        if (statement.declarations.length !== 1) return true;
        const declaration = statement.declarations[0];
        if (
          declaration?.id.type !== "Identifier" ||
          declaration.id.name !== model.globalVarName
        ) {
          return true;
        }
        scaffoldingRemoved += 1;
        return false;
      });
    }

    const resolverName = model.globalVarResolverName;
    if (resolverName && countIdentifier(ast, resolverName) === 1) {
      ast.program.body = ast.program.body.filter((statement) => {
        if (
          statement.type === "FunctionDeclaration" &&
          statement.id?.name === resolverName
        ) {
          scaffoldingRemoved += 1;
          return false;
        }
        return true;
      });
    }
  }

  return { replacements, helpersRemoved, scaffoldingRemoved };
}

export function createGlobalConcealing213Pass(): ReversePass {
  return {
    id: "jsconfuser.global-concealing.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["globals.recovered"],
    detect(ctx) {
      const models = findGlobalConcealingModels(ctx.cleanAst);
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.99 : 0,
        evidence:
          models.length > 0
            ? [`${models.length} generated global mapping switches`]
            : [],
      };
    },
    analyze(ctx) {
      const models = findGlobalConcealingModels(ctx.cleanAst);
      return {
        changed: false,
        facts: {
          "globalConcealing.models": models.map((model) => ({
            functionName: model.functionName,
            globalVarName: model.globalVarName,
            mappings: model.mappings.size,
          })),
        },
      };
    },
    transform(ctx) {
      const models = findGlobalConcealingModels(ctx.cleanAst);
      if (models.length === 0) return { changed: false };

      let safeStats: RecoveryStats | null = null;
      let cleanStats: RecoveryStats | null = null;
      const metadata = {
        confidence: 0.99,
        evidence: [
          "generated mapping switch returns one globalVar[string] per selector",
          "only static selector calls are restored",
        ],
      };

      const safeTransaction = runAstTransaction(
        ctx,
        "safe",
        {
          passId: "jsconfuser.global-concealing.v213",
          action: "restore-concealed-globals-safe",
          ...metadata,
        },
        (candidate) => {
          safeStats = recoverGlobalConcealing(candidate, models);
        },
      );
      const cleanTransaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.global-concealing.v213",
          action: "restore-concealed-globals-clean",
          ...metadata,
        },
        (candidate) => {
          cleanStats = recoverGlobalConcealing(candidate, models);
        },
      );

      const safeChanged =
        safeTransaction.committed && Boolean(safeStats?.replacements);
      const cleanChanged =
        cleanTransaction.committed && Boolean(cleanStats?.replacements);
      const stats = cleanStats;
      return {
        changed: safeChanged || cleanChanged,
        actions: stats
          ? [
              `restored ${stats.replacements} concealed global references`,
              `removed ${stats.helpersRemoved} mapping helpers`,
              `removed ${stats.scaffoldingRemoved} global resolver scaffolding statements`,
            ]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["static switch mapping and transactional syntax validation"],
      };
    },
  };
}
