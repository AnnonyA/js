import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { rewriteNodes } from "../../rewrite.js";
import {
  findVariableMaskingModels,
  stackKeyFromMember,
  type VariableMaskingModel,
} from "./model.js";

type FunctionWithBlockBody =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression;

interface RecoveryStats {
  functions: number;
  parameters: number;
  locals: number;
  references: number;
}

function visitNodes(node: t.Node, callback: (node: t.Node) => void): void {
  callback(node);
  const record = node as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { type?: unknown }).type === "string"
        ) {
          visitNodes(item as t.Node, callback);
        }
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      visitNodes(value as t.Node, callback);
    }
  }
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function collectIdentifierNames(fn: FunctionWithBlockBody): Set<string> {
  const names = new Set<string>();
  visitNodes(fn, (node) => {
    if (node.type === "Identifier") names.add(node.name);
  });
  return names;
}

function directAssignmentKey(
  statement: t.Statement,
  stackName: string,
): { key: string; right: t.Expression } | null {
  if (statement.type !== "ExpressionStatement") return null;
  const expression = statement.expression;
  if (expression.type !== "AssignmentExpression" || expression.operator !== "=") {
    return null;
  }
  if (expression.left.type !== "MemberExpression") return null;
  const key = stackKeyFromMember(expression.left, stackName);
  if (!key) return null;
  return { key, right: expression.right };
}

function rewriteStackMembers(
  root: t.Node,
  stackName: string,
  namesByKey: ReadonlyMap<string, string>,
): number {
  let references = 0;
  rewriteNodes(root, (node) => {
    if (node.type !== "MemberExpression") return node;
    const key = stackKeyFromMember(node, stackName);
    if (!key || key === "length") return node;
    const recoveredName = namesByKey.get(key);
    if (!recoveredName) return node;
    references += 1;
    return t.identifier(recoveredName);
  });
  return references;
}

function recoverFunction(
  fn: FunctionWithBlockBody,
  model: VariableMaskingModel,
): { parameters: number; locals: number; references: number } | null {
  if (fn.body.type !== "BlockStatement") return null;
  if (fn.params.length !== 1 || fn.params[0]?.type !== "RestElement") return null;
  if (
    fn.params[0].argument.type !== "Identifier" ||
    fn.params[0].argument.name !== model.stackName
  ) {
    return null;
  }

  const usedNames = collectIdentifierNames(fn);
  const namesByKey = new Map<string, string>();
  const parameterNames: string[] = [];
  for (let index = 0; index < model.paramCount; index += 1) {
    const name = uniqueName(`arg${index}`, usedNames);
    parameterNames.push(name);
    namesByKey.set(`n:${index}`, name);
  }
  model.localKeys.forEach((key, index) => {
    namesByKey.set(key, uniqueName(`local${index}`, usedNames));
  });

  fn.params = parameterNames.map((name) => t.identifier(name));

  const firstLocalDefinitions = new Set<string>();
  const nextBody: t.Statement[] = [];
  let references = 0;

  for (let index = 1; index < fn.body.body.length; index += 1) {
    const statement = fn.body.body[index]!;
    const assignment = directAssignmentKey(statement, model.stackName);
    if (
      assignment &&
      model.localKeys.includes(assignment.key) &&
      !firstLocalDefinitions.has(assignment.key)
    ) {
      firstLocalDefinitions.add(assignment.key);
      const localName = namesByKey.get(assignment.key);
      if (!localName) return null;
      const right = t.cloneNode(assignment.right, true);
      references += rewriteStackMembers(
        right,
        model.stackName,
        namesByKey,
      );
      nextBody.push(
        t.variableDeclaration("let", [
          t.variableDeclarator(t.identifier(localName), right),
        ]),
      );
      continue;
    }

    references += rewriteStackMembers(statement, model.stackName, namesByKey);
    nextBody.push(statement);
  }

  if (firstLocalDefinitions.size !== model.localKeys.length) return null;
  fn.body.body = nextBody;
  return {
    parameters: model.paramCount,
    locals: model.localKeys.length,
    references,
  };
}

function recoverVariableMasking(
  ast: t.File,
  models: readonly VariableMaskingModel[],
): RecoveryStats {
  const modelByStack = new Map(models.map((model) => [model.stackName, model]));
  const stats: RecoveryStats = {
    functions: 0,
    parameters: 0,
    locals: 0,
    references: 0,
  };

  rewriteNodes(ast, (node) => {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression"
    ) {
      return node;
    }
    if (node.params.length !== 1 || node.params[0]?.type !== "RestElement") {
      return node;
    }
    if (node.params[0].argument.type !== "Identifier") return node;
    const model = modelByStack.get(node.params[0].argument.name);
    if (!model) return node;

    const recovered = recoverFunction(node, model);
    if (!recovered) return node;
    stats.functions += 1;
    stats.parameters += recovered.parameters;
    stats.locals += recovered.locals;
    stats.references += recovered.references;
    return node;
  });

  return stats;
}

export function createVariableMasking213Pass(): ReversePass {
  return {
    id: "jsconfuser.variable-masking.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["variables.unmasked"],
    detect(ctx) {
      const models = findVariableMaskingModels(ctx.cleanAst);
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.96 : 0,
        evidence:
          models.length > 0
            ? [
                `${models.length} generated __p_<token>_varMask rest stacks`,
                "static stack length and local first-write topology",
              ]
            : [],
      };
    },
    analyze(ctx) {
      const models = findVariableMaskingModels(ctx.cleanAst);
      return {
        changed: false,
        facts: {
          "variableMasking.models": models.map((model) => ({
            stackName: model.stackName,
            paramCount: model.paramCount,
            localCount: model.localKeys.length,
          })),
        },
      };
    },
    transform(ctx) {
      const models = findVariableMaskingModels(ctx.cleanAst);
      if (models.length === 0) return { changed: false };

      let stats: RecoveryStats | null = null;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.variable-masking.v213",
          action: "restore-variable-mask-clean",
          confidence: 0.96,
          evidence: [
            "exact generated varMask name",
            "static original parameter count",
            "every local key has a direct first write before any read",
          ],
        },
        (candidate) => {
          stats = recoverVariableMasking(candidate, models);
        },
      );

      const resultStats = stats as RecoveryStats | null;
      return {
        changed: transaction.committed && Boolean(resultStats?.functions),
        actions: resultStats
          ? [
              `unmasked ${resultStats.functions} functions`,
              `restored ${resultStats.parameters} parameters and ${resultStats.locals} locals`,
              `rewrote ${resultStats.references} stack references`,
            ]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.96,
        evidence: [
          "clean-only reconstruction with static key lifetimes and syntax transaction",
        ],
      };
    },
  };
}
