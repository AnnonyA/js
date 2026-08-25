import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { rewriteNodes } from "../../rewrite.js";

export interface ExtractedObjectProperty {
  variableName: string;
  propertyName: string;
  value: t.Expression;
}

export interface ExtractedObjectModel {
  token: string;
  objectName: string;
  properties: ExtractedObjectProperty[];
}

interface CandidateDeclaration {
  token: string;
  objectName: string;
  propertyName: string;
  variableName: string;
  value: t.Expression;
}

function parseGeneratedIdentifier(
  name: string,
): { token: string; objectName: string; propertyName: string } | null {
  const match = /^__p_([A-Za-z0-9]{4})_([A-Za-z_$][A-Za-z0-9$]*)_([A-Za-z_$][A-Za-z0-9$]*)$/.exec(
    name,
  );
  if (!match) return null;
  return {
    token: match[1]!,
    objectName: match[2]!,
    propertyName: match[3]!,
  };
}

function candidateFromStatement(statement: t.Statement): CandidateDeclaration | null {
  if (statement.type !== "VariableDeclaration") return null;
  if (statement.declarations.length !== 1) return null;
  const declaration = statement.declarations[0];
  if (!declaration || declaration.id.type !== "Identifier") return null;
  if (!declaration.init || !t.isExpression(declaration.init)) return null;
  const parsed = parseGeneratedIdentifier(declaration.id.name);
  if (!parsed) return null;
  return {
    ...parsed,
    variableName: declaration.id.name,
    value: declaration.init,
  };
}

function collectModelsFromStatementList(
  statements: readonly t.Statement[],
  models: ExtractedObjectModel[],
): void {
  for (let index = 0; index < statements.length; index += 1) {
    const first = candidateFromStatement(statements[index]!);
    if (!first) continue;

    const candidates = [first];
    let cursor = index + 1;
    while (cursor < statements.length) {
      const next = candidateFromStatement(statements[cursor]!);
      if (
        !next ||
        next.token !== first.token ||
        next.objectName !== first.objectName
      ) {
        break;
      }
      candidates.push(next);
      cursor += 1;
    }

    if (candidates.length >= 2) {
      const propertyNames = new Set(candidates.map((item) => item.propertyName));
      if (propertyNames.size === candidates.length) {
        models.push({
          token: first.token,
          objectName: first.objectName,
          properties: candidates.map((item) => ({
            variableName: item.variableName,
            propertyName: item.propertyName,
            value: t.cloneNode(item.value, true),
          })),
        });
        index = cursor - 1;
      }
    }
  }
}

function visitStatementLists(node: t.Node, callback: (body: t.Statement[]) => void): void {
  if (node.type === "Program" || node.type === "BlockStatement") {
    callback(node.body);
  }

  const record = node as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { type?: unknown }).type === "string"
        ) {
          visitStatementLists(item as t.Node, callback);
        }
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      visitStatementLists(value as t.Node, callback);
    }
  }
}

export function findExtractedObjectModels(ast: t.File): ExtractedObjectModel[] {
  const models: ExtractedObjectModel[] = [];
  visitStatementLists(ast.program, (body) => collectModelsFromStatementList(body, models));
  return models;
}

function reconstructModelInStatements(
  body: t.Statement[],
  model: ExtractedObjectModel,
): boolean {
  const names = model.properties.map((property) => property.variableName);
  for (let index = 0; index <= body.length - names.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < names.length; offset += 1) {
      const candidate = candidateFromStatement(body[index + offset]!);
      if (!candidate || candidate.variableName !== names[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    const objectExpression = t.objectExpression(
      model.properties.map((property) =>
        t.objectProperty(
          t.identifier(property.propertyName),
          t.cloneNode(property.value, true),
        ),
      ),
    );
    body.splice(
      index,
      names.length,
      t.variableDeclaration("let", [
        t.variableDeclarator(t.identifier(model.objectName), objectExpression),
      ]),
    );
    return true;
  }
  return false;
}

function reconstructExtractedObjects(
  ast: t.File,
  models: readonly ExtractedObjectModel[],
): { reconstructed: number; referencesRestored: number } {
  let reconstructed = 0;
  for (const model of models) {
    let found = false;
    visitStatementLists(ast.program, (body) => {
      if (!found && reconstructModelInStatements(body, model)) found = true;
    });
    if (found) reconstructed += 1;
  }

  const propertiesByVariable = new Map<
    string,
    { objectName: string; propertyName: string }
  >();
  for (const model of models) {
    for (const property of model.properties) {
      propertiesByVariable.set(property.variableName, {
        objectName: model.objectName,
        propertyName: property.propertyName,
      });
    }
  }

  let referencesRestored = 0;
  rewriteNodes(ast, (node) => {
    if (node.type !== "Identifier") return node;
    const property = propertiesByVariable.get(node.name);
    if (!property) return node;
    referencesRestored += 1;
    return t.memberExpression(
      t.identifier(property.objectName),
      t.identifier(property.propertyName),
      false,
    );
  });

  return { reconstructed, referencesRestored };
}

export function createObjectExtraction213Pass(): ReversePass {
  return {
    id: "jsconfuser.object-extraction.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["objects.reconstructed"],
    detect(ctx) {
      const models = findExtractedObjectModels(ctx.cleanAst);
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.92 : 0,
        evidence:
          models.length > 0
            ? [`${models.length} contiguous generated object-property groups`]
            : [],
      };
    },
    analyze(ctx) {
      const models = findExtractedObjectModels(ctx.cleanAst);
      return {
        changed: false,
        facts: {
          "objectExtraction.models": models.map((model) => ({
            objectName: model.objectName,
            properties: model.properties.map((property) => property.propertyName),
          })),
        },
      };
    },
    transform(ctx) {
      const models = findExtractedObjectModels(ctx.cleanAst);
      if (models.length === 0) return { changed: false };

      let stats: { reconstructed: number; referencesRestored: number } | null = null;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.object-extraction.v213",
          action: "reconstruct-extracted-objects-clean",
          confidence: 0.92,
          evidence: [
            "shared __p_<token>_<object>_<property> identifier family",
            "contiguous generated declarations with unique simple property names",
          ],
        },
        (candidate) => {
          stats = reconstructExtractedObjects(candidate, models);
        },
      );

      return {
        changed: transaction.committed && Boolean(stats?.reconstructed),
        actions: stats
          ? [
              `reconstructed ${stats.reconstructed} extracted objects`,
              `restored ${stats.referencesRestored} object member references`,
            ]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.92,
        evidence: [
          "high-confidence generated-name family and transactional syntax validation",
        ],
      };
    },
  };
}
