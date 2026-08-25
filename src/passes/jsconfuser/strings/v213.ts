import * as t from "@babel/types";
import { evaluateConstant } from "../../../analysis/constants/index.js";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { countNodes, rewriteNodes } from "../../rewrite.js";
import {
  findDecoderModels,
  UNKNOWN_VALUE,
  type DecoderModel,
} from "./model.js";

interface RecoveryStats {
  found: number;
  recovered: number;
  wrappersRemoved: number;
  decodersRemoved: number;
  blobsRemoved: number;
}

function staticInteger(node: t.Expression): number | null {
  const evaluated = evaluateConstant({ node });
  if (
    !evaluated.confident ||
    typeof evaluated.value !== "number" ||
    !Number.isInteger(evaluated.value)
  ) {
    return null;
  }
  return evaluated.value;
}

function countCalls(ast: t.File, functionName: string): number {
  return countNodes(
    ast,
    (node) =>
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === functionName,
  );
}

function countIdentifiers(ast: t.File, name: string): number {
  return countNodes(
    ast,
    (node) => node.type === "Identifier" && node.name === name,
  );
}

function removeFunctions(ast: t.File, names: ReadonlySet<string>): number {
  let removed = 0;
  rewriteNodes(ast, (node) => {
    if (node.type !== "Program" && node.type !== "BlockStatement") return node;
    node.body = node.body.filter((statement) => {
      if (
        statement.type === "FunctionDeclaration" &&
        statement.id &&
        names.has(statement.id.name)
      ) {
        removed += 1;
        return false;
      }
      return true;
    });
    return node;
  });
  return removed;
}

function removeUnusedBlobDeclarations(
  ast: t.File,
  blobNames: ReadonlySet<string>,
): number {
  let removed = 0;
  const removable = new Set(
    [...blobNames].filter((name) => countIdentifiers(ast, name) <= 1),
  );
  if (removable.size === 0) return 0;

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

function recoverStaticStrings(ast: t.File): RecoveryStats {
  const models = findDecoderModels(ast);
  const byWrapper = new Map(models.map((model) => [model.wrapperName, model]));
  let found = 0;
  let recovered = 0;

  rewriteNodes(ast, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") {
      return node;
    }
    const model = byWrapper.get(node.callee.name);
    if (!model || node.arguments.length !== 2) return node;
    found += 1;

    const [startNode, lengthNode] = node.arguments;
    if (
      !startNode ||
      !lengthNode ||
      !t.isExpression(startNode) ||
      !t.isExpression(lengthNode)
    ) {
      return node;
    }
    const start = staticInteger(startNode);
    const length = staticInteger(lengthNode);
    if (start === null || length === null) return node;

    const value = model.decodeStatic([start, length]);
    if (value === UNKNOWN_VALUE || typeof value !== "string") return node;
    recovered += 1;
    return t.stringLiteral(value);
  });

  const removableWrappers = new Set(
    models
      .filter((model) => countCalls(ast, model.wrapperName) === 0)
      .map((model) => model.wrapperName),
  );
  const wrappersRemoved = removeFunctions(ast, removableWrappers);

  const removableDecoders = new Set(
    models
      .filter((model) => countCalls(ast, model.decoderName) === 0)
      .map((model) => model.decoderName),
  );
  const decodersRemoved = removeFunctions(ast, removableDecoders);

  const blobsRemoved = removeUnusedBlobDeclarations(
    ast,
    new Set(models.map((model) => model.stringsName)),
  );

  return {
    found,
    recovered,
    wrappersRemoved,
    decodersRemoved,
    blobsRemoved,
  };
}

function candidateCount(ast: t.File, models: readonly DecoderModel[]): number {
  const names = new Set(models.map((model) => model.wrapperName));
  return countNodes(
    ast,
    (node) =>
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      names.has(node.callee.name),
  );
}

export function createStringConcealing213Pass(): ReversePass {
  return {
    id: "jsconfuser.strings.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["strings.static-decoded"],
    detect(ctx) {
      const models = findDecoderModels(ctx.cleanAst);
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.99 : 0,
        evidence:
          models.length > 0
            ? [`${models.length} structurally verified Base91 decoder models`]
            : [],
      };
    },
    analyze(ctx) {
      const models = findDecoderModels(ctx.cleanAst);
      return {
        changed: false,
        facts: {
          "strings.models": models.map((model) => ({
            wrapperName: model.wrapperName,
            decoderName: model.decoderName,
            stringsName: model.stringsName,
          })),
          "strings.candidates": candidateCount(ctx.cleanAst, models),
        },
      };
    },
    transform(ctx) {
      const cleanModels = findDecoderModels(ctx.cleanAst);
      if (cleanModels.length === 0) return { changed: false };

      let safeStats: RecoveryStats | null = null;
      let cleanStats: RecoveryStats | null = null;

      const safeTransaction = runAstTransaction(
        ctx,
        "safe",
        {
          passId: "jsconfuser.strings.v213",
          action: "decode-proven-static-strings-safe",
          confidence: 0.99,
          evidence: ["Base91 decoder topology extracted from AST"],
        },
        (candidate) => {
          safeStats = recoverStaticStrings(candidate);
        },
      );

      const cleanTransaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.strings.v213",
          action: "decode-proven-static-strings-clean",
          confidence: 0.99,
          evidence: ["Base91 decoder topology extracted from AST"],
        },
        (candidate) => {
          cleanStats = recoverStaticStrings(candidate);
        },
      );

      const stats = cleanStats as RecoveryStats | null;
      if (cleanTransaction.committed && stats) {
        ctx.report.recovery.strings.found = Math.max(
          ctx.report.recovery.strings.found,
          stats.found,
        );
        ctx.report.recovery.strings.recovered = Math.max(
          ctx.report.recovery.strings.recovered,
          stats.recovered,
        );
      }

      const safeChanged =
        safeTransaction.committed && (safeStats as RecoveryStats | null)?.recovered;
      const cleanChanged = cleanTransaction.committed && stats?.recovered;

      return {
        changed: Boolean(safeChanged || cleanChanged),
        actions: stats
          ? [
              `decoded ${stats.recovered}/${stats.found} string callsites`,
              `removed ${stats.wrappersRemoved} wrappers and ${stats.decodersRemoved} decoders`,
            ]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.99,
        evidence: ["bounded static decoder; no input JavaScript executed"],
      };
    },
  };
}
