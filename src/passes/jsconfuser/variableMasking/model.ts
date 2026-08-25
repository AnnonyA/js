import type * as t from "@babel/types";

export interface VariableMaskingModel {
  stackName: string;
  paramCount: number;
  localKeys: string[];
}

type FunctionWithBlockBody =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression;

function isGeneratedStackName(name: string): boolean {
  return /^__p_[A-Za-z0-9]{4}_varMask$/.test(name);
}

function signedNumber(node: t.Node): number | null {
  if (node.type === "NumericLiteral" && Number.isFinite(node.value)) {
    return node.value;
  }
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "NumericLiteral" &&
    Number.isFinite(node.argument.value)
  ) {
    return -node.argument.value;
  }
  return null;
}

export function stackKeyFromMember(
  member: t.MemberExpression,
  stackName: string,
): string | null {
  if (member.object.type !== "Identifier" || member.object.name !== stackName) {
    return null;
  }

  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name === "length" ? "length" : null;
  }
  if (!member.computed || member.property.type === "PrivateName") return null;

  if (member.property.type === "StringLiteral") {
    return member.property.value === "length"
      ? "length"
      : `s:${member.property.value}`;
  }
  const numberValue = signedNumber(member.property);
  return numberValue === null ? null : `n:${numberValue}`;
}

function directStackAssignment(
  statement: t.Statement,
  stackName: string,
): { key: string; right: t.Expression } | null {
  if (statement.type !== "ExpressionStatement") return null;
  const expression = statement.expression;
  if (expression.type !== "AssignmentExpression" || expression.operator !== "=") {
    return null;
  }
  if (expression.left.type !== "MemberExpression") return null;
  if (!expression.right || !isExpression(expression.right)) return null;
  const key = stackKeyFromMember(expression.left, stackName);
  return key ? { key, right: expression.right } : null;
}

function isExpression(node: t.Node): node is t.Expression {
  return ![
    "ArgumentPlaceholder",
    "JSXNamespacedName",
    "RestElement",
  ].includes(node.type);
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

function stackKeysInNode(node: t.Node, stackName: string): string[] | null {
  const keys: string[] = [];
  let invalid = false;
  visitNodes(node, (child) => {
    if (invalid || child.type !== "MemberExpression") return;
    if (child.object.type !== "Identifier" || child.object.name !== stackName) {
      return;
    }
    const key = stackKeyFromMember(child, stackName);
    if (key === null) {
      invalid = true;
      return;
    }
    keys.push(key);
  });
  return invalid ? null : keys;
}

function modelFunction(fn: FunctionWithBlockBody): VariableMaskingModel | null {
  if (fn.body.type !== "BlockStatement") return null;
  if (fn.params.length !== 1 || fn.params[0]?.type !== "RestElement") return null;
  const rest = fn.params[0];
  if (rest.argument.type !== "Identifier") return null;
  const stackName = rest.argument.name;
  if (!isGeneratedStackName(stackName)) return null;
  if (fn.body.body.length < 2) return null;

  const lengthAssignment = directStackAssignment(fn.body.body[0]!, stackName);
  if (!lengthAssignment || lengthAssignment.key !== "length") return null;
  if (lengthAssignment.right.type !== "NumericLiteral") return null;
  const paramCount = lengthAssignment.right.value;
  if (!Number.isInteger(paramCount) || paramCount < 0 || paramCount > 128) {
    return null;
  }

  const paramKeys = new Set(
    Array.from({ length: paramCount }, (_, index) => `n:${index}`),
  );
  const firstDefinitionIndex = new Map<string, number>();
  const localKeyOrder: string[] = [];

  for (let index = 1; index < fn.body.body.length; index += 1) {
    const statement = fn.body.body[index]!;
    const assignment = directStackAssignment(statement, stackName);
    if (
      assignment &&
      assignment.key !== "length" &&
      !paramKeys.has(assignment.key) &&
      !firstDefinitionIndex.has(assignment.key)
    ) {
      firstDefinitionIndex.set(assignment.key, index);
      localKeyOrder.push(assignment.key);
    }
  }

  if (localKeyOrder.length === 0) return null;

  for (let index = 1; index < fn.body.body.length; index += 1) {
    const statement = fn.body.body[index]!;
    const keys = stackKeysInNode(statement, stackName);
    if (keys === null) return null;

    const direct = directStackAssignment(statement, stackName);
    for (const key of keys) {
      if (key === "length") return null;
      if (paramKeys.has(key)) continue;
      const definitionIndex = firstDefinitionIndex.get(key);
      if (definitionIndex === undefined) return null;
      if (index < definitionIndex) return null;
      if (index === definitionIndex) {
        if (!direct || direct.key !== key) return null;
        const rhsKeys = stackKeysInNode(direct.right, stackName);
        if (rhsKeys === null || rhsKeys.includes(key)) return null;
      }
    }
  }

  return {
    stackName,
    paramCount,
    localKeys: localKeyOrder,
  };
}

export function findVariableMaskingModels(ast: t.File): VariableMaskingModel[] {
  const models: VariableMaskingModel[] = [];
  visitNodes(ast.program, (node) => {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression"
    ) {
      return;
    }
    const model = modelFunction(node);
    if (model) models.push(model);
  });
  return models;
}
