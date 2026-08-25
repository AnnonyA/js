import type * as t from "@babel/types";

export interface DispatchedFunctionModel {
  selector: string;
  params: t.Identifier[];
  body: t.Statement[];
}

export interface DispatcherModel {
  dispatcherName: string;
  payloadName: string;
  cacheName: string | null;
  clearPayloadFlag: string | null;
  nonCallFlag: string;
  returnObjectFlag: string | null;
  returnObjectProperty: string | null;
  functions: DispatchedFunctionModel[];
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

function equalityString(test: t.Expression, identifierName: string): string | null {
  if (test.type !== "BinaryExpression") return null;
  if (test.operator !== "===" && test.operator !== "==") return null;
  if (
    test.left.type === "Identifier" &&
    test.left.name === identifierName &&
    test.right.type === "StringLiteral"
  ) {
    return test.right.value;
  }
  if (
    test.right.type === "Identifier" &&
    test.right.name === identifierName &&
    test.left.type === "StringLiteral"
  ) {
    return test.left.value;
  }
  return null;
}

function assignmentToEmptyArray(node: t.Node, name: string): boolean {
  let matched = false;
  visitNodes(node, (child) => {
    if (
      child.type === "AssignmentExpression" &&
      child.operator === "=" &&
      child.left.type === "Identifier" &&
      child.left.name === name &&
      child.right.type === "ArrayExpression" &&
      child.right.elements.length === 0
    ) {
      matched = true;
    }
  });
  return matched;
}

function containsRestApplyThis(node: t.Node): boolean {
  let rest = false;
  let applyThis = false;
  visitNodes(node, (child) => {
    if (child.type === "RestElement") rest = true;
    if (
      child.type === "CallExpression" &&
      child.callee.type === "MemberExpression" &&
      child.callee.property.type === "Identifier" &&
      child.callee.property.name === "apply" &&
      child.arguments[0]?.type === "ThisExpression"
    ) {
      applyThis = true;
    }
  });
  return rest && applyThis;
}

function returnedObjectProperty(node: t.Node): string | null {
  let propertyName: string | null = null;
  visitNodes(node, (child) => {
    if (propertyName || child.type !== "ReturnStatement") return;
    if (child.argument?.type !== "ObjectExpression") return;
    if (child.argument.properties.length !== 1) return;
    const property = child.argument.properties[0];
    if (property?.type !== "ObjectProperty") return;
    if (property.key.type === "StringLiteral") propertyName = property.key.value;
    if (!property.computed && property.key.type === "Identifier") {
      propertyName = property.key.name;
    }
  });
  return propertyName;
}

function findCacheName(ast: t.File): string | null {
  for (const statement of ast.program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    if (statement.declarations.length !== 1) continue;
    const declaration = statement.declarations[0];
    if (declaration?.id.type !== "Identifier") continue;
    if (!/^__p_[A-Za-z0-9]{4}_cache$/.test(declaration.id.name)) continue;
    if (declaration.init?.type !== "CallExpression") continue;
    if (declaration.init.arguments.length !== 1) continue;
    if (declaration.init.arguments[0]?.type !== "NullLiteral") continue;
    if (declaration.init.callee.type !== "MemberExpression") continue;
    const property = declaration.init.callee.property;
    if (
      !(
        (property.type === "StringLiteral" && property.value === "create") ||
        (!declaration.init.callee.computed &&
          property.type === "Identifier" &&
          property.name === "create")
      )
    ) {
      continue;
    }
    return declaration.id.name;
  }
  return null;
}

function extractFunctionMap(
  dispatcher: t.FunctionDeclaration,
): { payloadName: string; functions: DispatchedFunctionModel[] } | null {
  for (const statement of dispatcher.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    if (statement.declarations.length !== 1) continue;
    const declaration = statement.declarations[0];
    if (declaration?.init?.type !== "ObjectExpression") continue;

    const rawFunctions: Array<{
      selector: string;
      fn: t.FunctionExpression;
    }> = [];
    let valid = true;
    for (const property of declaration.init.properties) {
      if (
        property.type !== "ObjectProperty" ||
        property.key.type !== "StringLiteral" ||
        property.value.type !== "FunctionExpression"
      ) {
        valid = false;
        break;
      }
      rawFunctions.push({ selector: property.key.value, fn: property.value });
    }
    if (!valid || rawFunctions.length < 2) continue;

    let payloadName: string | null = null;
    const functions: DispatchedFunctionModel[] = [];
    for (const raw of rawFunctions) {
      const body = raw.fn.body.body;
      let params: t.Identifier[] = [];
      let bodyStart = 0;
      if (body[0]?.type === "VariableDeclaration") {
        const first = body[0];
        if (first.declarations.length === 1) {
          const item = first.declarations[0];
          if (
            item?.id.type === "ArrayPattern" &&
            item.init?.type === "Identifier" &&
            item.id.elements.every(
              (element): element is t.Identifier => element?.type === "Identifier",
            )
          ) {
            if (!/^__p_[A-Za-z0-9]{4}_payload$/.test(item.init.name)) {
              return null;
            }
            if (payloadName === null) payloadName = item.init.name;
            if (payloadName !== item.init.name) return null;
            params = item.id.elements;
            bodyStart = 1;
          }
        }
      }
      functions.push({
        selector: raw.selector,
        params,
        body: body.slice(bodyStart),
      });
    }

    if (!payloadName) continue;
    return { payloadName, functions };
  }
  return null;
}

function modelDispatcher(
  ast: t.File,
  dispatcher: t.FunctionDeclaration,
): DispatcherModel | null {
  if (!dispatcher.id || !/^__p_[A-Za-z0-9]{4}_dispatcher_\d+$/.test(dispatcher.id.name)) {
    return null;
  }
  if (dispatcher.params.length < 3) return null;
  const nameParam = dispatcher.params[0];
  const flagParam = dispatcher.params[1];
  const returnParam = dispatcher.params[2];
  if (
    nameParam?.type !== "Identifier" ||
    flagParam?.type !== "Identifier" ||
    returnParam?.type !== "Identifier"
  ) {
    return null;
  }

  const map = extractFunctionMap(dispatcher);
  if (!map) return null;

  let clearPayloadFlag: string | null = null;
  let nonCallFlag: string | null = null;
  let returnObjectFlag: string | null = null;
  let returnObjectProperty: string | null = null;

  for (const statement of dispatcher.body.body) {
    if (statement.type !== "IfStatement") continue;
    const flagValue = equalityString(statement.test, flagParam.name);
    if (flagValue && assignmentToEmptyArray(statement.consequent, map.payloadName)) {
      clearPayloadFlag = flagValue;
    }
    if (flagValue && containsRestApplyThis(statement.consequent)) {
      nonCallFlag = flagValue;
    }

    const returnValue = equalityString(statement.test, returnParam.name);
    if (returnValue) {
      const property = returnedObjectProperty(statement.consequent);
      if (property) {
        returnObjectFlag = returnValue;
        returnObjectProperty = property;
      }
    }
  }

  if (!nonCallFlag) return null;
  return {
    dispatcherName: dispatcher.id.name,
    payloadName: map.payloadName,
    cacheName: findCacheName(ast),
    clearPayloadFlag,
    nonCallFlag,
    returnObjectFlag,
    returnObjectProperty,
    functions: map.functions,
  };
}

export function findDispatcherModels(ast: t.File): DispatcherModel[] {
  const models: DispatcherModel[] = [];
  for (const statement of ast.program.body) {
    if (statement.type !== "FunctionDeclaration") continue;
    const model = modelDispatcher(ast, statement);
    if (model) models.push(model);
  }
  return models;
}
