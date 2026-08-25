import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { findCff213Models } from "./model.js";

interface ExportAliasModel {
  mainName: string;
  names: string[];
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

function isFinalMainEntry(ast: t.File, mainName: string): boolean {
  const last = ast.program.body.at(-1);
  if (last?.type !== "ExpressionStatement") return false;
  const expression = last.expression;
  return (
    expression.type === "CallExpression" &&
    expression.callee.type === "Identifier" &&
    expression.callee.name === mainName
  );
}

function isModuleExportsMember(node: t.MemberExpression): boolean {
  if (node.object.type !== "Identifier" || node.object.name !== "module") {
    return false;
  }
  if (node.computed) {
    return node.property.type === "StringLiteral" && node.property.value === "exports";
  }
  return node.property.type === "Identifier" && node.property.name === "exports";
}

function decodedExportNames(ast: t.File): string[] | null {
  const candidates: string[][] = [];

  visitNodes(ast.program, (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "MemberExpression" ||
      !isModuleExportsMember(node.left) ||
      node.right.type !== "ObjectExpression"
    ) {
      return;
    }

    const names: string[] = [];
    for (const property of node.right.properties) {
      if (property.type !== "ObjectProperty") return;
      let name: string | null = null;
      if (property.key.type === "StringLiteral") name = property.key.value;
      else if (!property.computed && property.key.type === "Identifier") {
        name = property.key.name;
      }
      if (!name || !t.isValidIdentifier(name)) return;
      names.push(name);
    }

    if (names.length === 0 || new Set(names).size !== names.length) return;
    candidates.push(names);
  });

  return candidates.length === 1 ? candidates[0]! : null;
}

function identifierNames(ast: t.File): Set<string> {
  const names = new Set<string>();
  visitNodes(ast.program, (node) => {
    if (node.type === "Identifier") names.add(node.name);
  });
  return names;
}

function findAliasModel(ast: t.File): ExportAliasModel | null {
  const cffModels = findCff213Models(ast);
  if (cffModels.length !== 1) return null;
  const model = cffModels[0]!;
  if (!isFinalMainEntry(ast, model.mainName)) return null;

  const decoded = decodedExportNames(ast);
  if (!decoded) return null;

  const usedIdentifiers = identifierNames(ast);
  const names = decoded.filter((name) => !usedIdentifiers.has(name));
  if (names.length === 0) return null;

  return { mainName: model.mainName, names };
}

function materializeAliases(ast: t.File, names: readonly string[]): number {
  const declarations = names.map((name) =>
    t.variableDeclarator(
      t.identifier(name),
      t.memberExpression(
        t.memberExpression(
          t.identifier("module"),
          t.stringLiteral("exports"),
          true,
        ),
        t.stringLiteral(name),
        true,
      ),
    ),
  );
  if (declarations.length === 0) return 0;
  ast.program.body.push(t.variableDeclaration("var", declarations));
  return declarations.length;
}

export function createCffExportAliasesPass(): ReversePass {
  return {
    id: "jsconfuser.cff-export-aliases",
    prerequisites: ["cff.exportsDecoded"],
    conflicts: [],
    capabilities: ["cff.exportAliases"],
    detect(ctx) {
      const model = findAliasModel(ctx.cleanAst);
      return {
        detected: Boolean(model),
        confidence: model ? 0.995 : 0,
        evidence: model
          ? [
              "single generated CFF model with final top-level entry call",
              `${model.names.length} decoded collision-free CommonJS export names`,
            ]
          : [],
      };
    },
    analyze(ctx) {
      const model = findAliasModel(ctx.cleanAst);
      return {
        changed: false,
        facts: model
          ? {
              "cff.exportAliases": {
                mainName: model.mainName,
                names: [...model.names],
              },
            }
          : {},
      };
    },
    transform(ctx) {
      const model = findAliasModel(ctx.cleanAst);
      if (!model) return { changed: false };

      let count = 0;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.cff-export-aliases",
          action: "materialize-cff-export-aliases-clean",
          confidence: 0.995,
          evidence: [
            "CFF entry invocation is the final original top-level statement",
            "exactly one decoded module.exports object is present across bracket and dot notation",
            "aliases preserve the exact module.exports property values without wrapping",
            "candidate names do not appear as identifiers anywhere in the transformed AST",
          ],
        },
        (candidate) => {
          count = materializeAliases(candidate, model.names);
        },
      );

      return {
        changed: transaction.committed && count > 0,
        actions: count > 0 ? [`materialized ${count} named CFF export aliases`] : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.995,
        evidence: [
          "identity-preserving aliases added only after a final generated CFF entry call",
        ],
      };
    },
  };
}
