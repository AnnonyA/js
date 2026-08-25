import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { countNodes, rewriteNodes } from "../../rewrite.js";
import {
  findCalculatorModels,
  type CalculatorModel,
} from "./model.js";

function rewriteCalculatorCalls(
  ast: t.File,
  models: readonly CalculatorModel[],
): { replacements: number; helpersRemoved: number } {
  const byName = new Map(models.map((model) => [model.functionName, model]));
  let replacements = 0;

  rewriteNodes(ast, (node) => {
    if (node.type !== "CallExpression") return node;
    if (node.callee.type !== "Identifier") return node;
    const model = byName.get(node.callee.name);
    if (!model || node.arguments.length !== 3) return node;

    const [selector, left, right] = node.arguments;
    if (selector?.type !== "StringLiteral") return node;
    if (!left || !right || !t.isExpression(left) || !t.isExpression(right)) return node;
    const operator = model.operators.get(selector.value);
    if (!operator) return node;

    replacements += 1;
    return t.binaryExpression(
      operator,
      t.cloneNode(left, true),
      t.cloneNode(right, true),
    );
  });

  let helpersRemoved = 0;
  ast.program.body = ast.program.body.filter((statement) => {
    if (statement.type !== "FunctionDeclaration" || !statement.id) return true;
    if (!byName.has(statement.id.name)) return true;
    const remainingCalls = countNodes(
      ast,
      (node) =>
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === statement.id?.name,
    );
    if (remainingCalls > 0) return true;
    helpersRemoved += 1;
    return false;
  });

  return { replacements, helpersRemoved };
}

export function createCalculator213Pass(): ReversePass {
  return {
    id: "jsconfuser.calculator.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["calculator.reversed"],
    detect(ctx) {
      const models = findCalculatorModels(ctx.cleanAst);
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.99 : 0,
        evidence:
          models.length > 0
            ? [`${models.length} generated *_calc switch helpers`]
            : [],
      };
    },
    analyze(ctx) {
      const models = findCalculatorModels(ctx.cleanAst);
      return {
        changed: false,
        facts: {
          "calculator.models": models.map((model) => ({
            functionName: model.functionName,
            selectors: [...model.operators.keys()],
          })),
        },
      };
    },
    transform(ctx) {
      const models = findCalculatorModels(ctx.cleanAst);
      if (models.length === 0) return { changed: false };

      let replacements = 0;
      let helpersRemoved = 0;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.calculator.v213",
          action: "restore-native-operators",
          confidence: 0.99,
          evidence: [
            `${models.length} structurally verified calculator helpers`,
            "selector cases map directly to pure binary operators",
          ],
        },
        (candidate) => {
          const result = rewriteCalculatorCalls(candidate, models);
          replacements = result.replacements;
          helpersRemoved = result.helpersRemoved;
        },
      );

      return {
        changed: transaction.committed && replacements > 0,
        actions:
          replacements > 0
            ? [
                `restored ${replacements} native operator calls`,
                `removed ${helpersRemoved} unused calculator helpers`,
              ]
            : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["helper topology proven and syntax transaction passed"],
      };
    },
  };
}
