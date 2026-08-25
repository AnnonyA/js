import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { parseJavaScript } from "../../../parser/parse.js";
import { rewriteNodes } from "../../rewrite.js";

type PackMappingKind = "value" | "typeof";

interface PackMapping {
  property: string;
  identifier: string;
  kind: PackMappingKind;
  hasSetter: boolean;
}

interface PackModel {
  statementIndex: number;
  scopeName: string;
  payload: string;
  mappings: Map<string, PackMapping>;
  payloadReferences: number;
}

function propertyName(node: t.ObjectMethod): string | null {
  if (node.computed) {
    return node.key.type === "StringLiteral" ? node.key.value : null;
  }
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "StringLiteral") return node.key.value;
  return null;
}

function getterMapping(method: t.ObjectMethod): Omit<PackMapping, "hasSetter"> | null {
  if (method.kind !== "get" || method.params.length !== 0) return null;
  const property = propertyName(method);
  if (!property || method.body.body.length !== 1) return null;
  const statement = method.body.body[0];
  if (statement?.type !== "ReturnStatement" || !statement.argument) return null;

  if (statement.argument.type === "Identifier") {
    return {
      property,
      identifier: statement.argument.name,
      kind: "value",
    };
  }
  if (
    statement.argument.type === "UnaryExpression" &&
    statement.argument.operator === "typeof" &&
    statement.argument.argument.type === "Identifier"
  ) {
    return {
      property,
      identifier: statement.argument.argument.name,
      kind: "typeof",
    };
  }
  return null;
}

function coherentSetter(method: t.ObjectMethod, mapping: PackMapping): boolean {
  if (method.kind !== "set" || mapping.kind !== "value") return false;
  const property = propertyName(method);
  if (property !== mapping.property || method.params.length !== 1) return false;
  const parameter = method.params[0];
  if (parameter?.type !== "Identifier" || method.body.body.length !== 1) return false;
  const statement = method.body.body[0];
  return Boolean(
    statement?.type === "ReturnStatement" &&
    statement.argument?.type === "AssignmentExpression" &&
    statement.argument.operator === "=" &&
    statement.argument.left.type === "Identifier" &&
    statement.argument.left.name === mapping.identifier &&
    statement.argument.right.type === "Identifier" &&
    statement.argument.right.name === parameter.name
  );
}

function memberProperty(node: t.MemberExpression, scopeName: string): string | null {
  if (node.object.type !== "Identifier" || node.object.name !== scopeName) return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "StringLiteral") return node.property.value;
  return null;
}

function parsePackPayload(payload: string): t.File | null {
  try {
    return parseJavaScript(payload, "<js-confuser-pack>");
  } catch {
    return null;
  }
}

function inspectPackExpression(expression: t.Expression, statementIndex: number): PackModel | null {
  if (
    expression.type !== "CallExpression" ||
    expression.arguments.length !== 1 ||
    expression.arguments[0]?.type !== "ObjectExpression" ||
    expression.callee.type !== "CallExpression" ||
    expression.callee.callee.type !== "Identifier" ||
    expression.callee.callee.name !== "Function" ||
    expression.callee.arguments.length !== 2
  ) {
    return null;
  }

  const [scopeArgument, payloadArgument] = expression.callee.arguments;
  if (
    scopeArgument?.type !== "StringLiteral" ||
    payloadArgument?.type !== "StringLiteral" ||
    !scopeArgument.value
  ) {
    return null;
  }

  const accessors = expression.arguments[0].properties;
  if (accessors.length === 0 || accessors.some((property) => property.type !== "ObjectMethod")) {
    return null;
  }

  const mappings = new Map<string, PackMapping>();
  const setters: t.ObjectMethod[] = [];
  for (const property of accessors) {
    if (property.type !== "ObjectMethod") return null;
    if (property.kind === "set") {
      setters.push(property);
      continue;
    }
    const getter = getterMapping(property);
    if (!getter || mappings.has(getter.property)) return null;
    mappings.set(getter.property, { ...getter, hasSetter: false });
  }
  if (mappings.size === 0) return null;

  for (const setter of setters) {
    const property = propertyName(setter);
    if (!property) return null;
    const mapping = mappings.get(property);
    if (!mapping || mapping.hasSetter || !coherentSetter(setter, mapping)) return null;
    mapping.hasSetter = true;
  }

  const payloadAst = parsePackPayload(payloadArgument.value);
  if (!payloadAst) return null;
  let payloadReferences = 0;
  let invalidScopeReference = false;
  rewriteNodes(payloadAst, (node) => {
    if (node.type === "Identifier" && node.name === scopeArgument.value) {
      return node;
    }
    if (node.type !== "MemberExpression") return node;
    if (node.object.type !== "Identifier" || node.object.name !== scopeArgument.value) return node;
    const property = memberProperty(node, scopeArgument.value);
    if (!property || !mappings.has(property)) {
      invalidScopeReference = true;
      return node;
    }
    payloadReferences += 1;
    return node;
  });
  if (invalidScopeReference || payloadReferences === 0) return null;

  return {
    statementIndex,
    scopeName: scopeArgument.value,
    payload: payloadArgument.value,
    mappings,
    payloadReferences,
  };
}

function findPackModels(ast: t.File): PackModel[] {
  const models: PackModel[] = [];
  for (let index = 0; index < ast.program.body.length; index += 1) {
    const statement = ast.program.body[index];
    if (statement?.type !== "ExpressionStatement") continue;
    const model = inspectPackExpression(statement.expression, index);
    if (model) models.push(model);
  }
  return models;
}

function rewritePayload(model: PackModel): t.Statement[] | null {
  const payloadAst = parsePackPayload(model.payload);
  if (!payloadAst) return null;

  rewriteNodes(payloadAst, (node) => {
    if (node.type !== "MemberExpression") return node;
    const property = memberProperty(node, model.scopeName);
    if (!property) return node;
    const mapping = model.mappings.get(property);
    if (!mapping) return node;
    if (mapping.kind === "typeof") {
      return t.unaryExpression("typeof", t.identifier(mapping.identifier), true);
    }
    return t.identifier(mapping.identifier);
  });

  const body = payloadAst.program.body;
  const last = body.at(-1);
  if (last?.type === "ReturnStatement" && last.argument && t.isExpression(last.argument)) {
    body[body.length - 1] = t.expressionStatement(t.cloneNode(last.argument, true));
  }

  return body.map((statement) => t.cloneNode(statement, true));
}

function unpackModels(ast: t.File): number {
  const models = findPackModels(ast).sort((a, b) => b.statementIndex - a.statementIndex);
  let unpacked = 0;
  for (const model of models) {
    const statements = rewritePayload(model);
    if (!statements) continue;
    ast.program.body.splice(model.statementIndex, 1, ...statements);
    unpacked += 1;
  }
  return unpacked;
}

export function createPack213Pass(): ReversePass {
  return {
    id: "jsconfuser.pack.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["pack.unpacked"],
    detect(ctx) {
      const models = findPackModels(ctx.cleanAst);
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.995 : 0,
        evidence: models.length > 0
          ? [
              `${models.length} Function-constructor Pack wrapper(s) with coherent accessor mappings`,
              `${models.reduce((sum, model) => sum + model.payloadReferences, 0)} payload references resolve through the packed scope`,
            ]
          : [],
      };
    },
    analyze(ctx) {
      const models = findPackModels(ctx.cleanAst);
      return {
        changed: false,
        facts: {
          "pack.models": models.map((model) => ({
            scopeName: model.scopeName,
            mappingCount: model.mappings.size,
            payloadReferences: model.payloadReferences,
          })),
        },
      };
    },
    transform(ctx) {
      if (findPackModels(ctx.cleanAst).length === 0) return { changed: false };

      let cleanCount = 0;
      const clean = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.pack.v213",
          action: "statically-unpack-function-payload-clean",
          confidence: 0.995,
          evidence: [
            "Function constructor arguments are static strings",
            "packed object consists only of coherent getter/setter accessors",
            "payload member references resolve to those accessors",
          ],
        },
        (candidate) => {
          cleanCount = unpackModels(candidate);
        },
      );

      let safeCount = 0;
      const safe = runAstTransaction(
        ctx,
        "safe",
        {
          passId: "jsconfuser.pack.v213",
          action: "statically-unpack-function-payload-safe",
          confidence: 0.995,
          evidence: [
            "static payload extraction performs no execution",
            "getter/setter mappings are structurally verified before replacement",
          ],
        },
        (candidate) => {
          safeCount = unpackModels(candidate);
        },
      );

      const changed =
        (clean.committed && cleanCount > 0) ||
        (safe.committed && safeCount > 0);
      return {
        changed,
        actions: changed
          ? [`unpacked ${Math.max(cleanCount, safeCount)} js-confuser Pack wrapper(s)`]
          : [],
      };
    },
    verify(_ctx, result) {
      return {
        valid: true,
        confidence: result.changed ? 0.995 : 0.99,
        evidence: [
          "payload parsed successfully and both AST transactions passed syntax validation",
        ],
      };
    },
  };
}
