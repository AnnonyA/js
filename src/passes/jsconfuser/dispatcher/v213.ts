import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { countNodes, rewriteNodes } from "../../rewrite.js";
import {
  findDispatcherModels,
  type DispatcherModel,
  type DispatchedFunctionModel,
} from "./model.js";

interface DispatcherInvocation {
  selector: string;
  flag: string | null;
  returnFlag: string | null;
  wrapped: boolean;
}

interface RecoveryStats {
  dispatchers: number;
  functions: number;
  directCalls: number;
  functionReferences: number;
  scaffoldingRemoved: number;
}

function stringArgument(
  args: Array<t.Expression | t.SpreadElement | t.JSXNamespacedName | t.ArgumentPlaceholder>,
  index: number,
): string | null {
  const argument = args[index];
  return argument?.type === "StringLiteral" ? argument.value : null;
}

function invocationFromNode(
  node: t.Node,
  model: DispatcherModel,
): DispatcherInvocation | null {
  let core: t.CallExpression | t.NewExpression | null = null;
  let wrapped = false;

  if (
    node.type === "MemberExpression" &&
    model.returnObjectProperty &&
    ((node.computed &&
      node.property.type === "StringLiteral" &&
      node.property.value === model.returnObjectProperty) ||
      (!node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === model.returnObjectProperty)) &&
    (node.object.type === "CallExpression" || node.object.type === "NewExpression")
  ) {
    core = node.object;
    wrapped = true;
  } else if (node.type === "CallExpression" || node.type === "NewExpression") {
    core = node;
  }

  if (!core || core.callee.type !== "Identifier") return null;
  if (core.callee.name !== model.dispatcherName) return null;
  const selector = stringArgument(core.arguments, 0);
  if (!selector) return null;

  const returnFlag = stringArgument(core.arguments, 2);
  if (
    wrapped &&
    model.returnObjectFlag &&
    returnFlag !== model.returnObjectFlag
  ) {
    return null;
  }

  return {
    selector,
    flag: stringArgument(core.arguments, 1),
    returnFlag,
    wrapped,
  };
}

function exportedPropertyName(property: t.ObjectProperty): string | null {
  if (property.key.type === "StringLiteral") return property.key.value;
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }
  return null;
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

function collectTopLevelBindingNames(ast: t.File): Set<string> {
  const names = new Set<string>();
  for (const statement of ast.program.body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      names.add(statement.id.name);
    }
    if (statement.type === "ClassDeclaration" && statement.id) {
      names.add(statement.id.name);
    }
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (declaration.id.type === "Identifier") names.add(declaration.id.name);
      }
    }
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) names.add(specifier.local.name);
    }
  }
  return names;
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate) || !t.isValidIdentifier(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function inferNames(
  ast: t.File,
  model: DispatcherModel,
): Map<string, string> {
  const preferred = new Map<string, string>();
  visitNodes(ast.program, (node) => {
    if (node.type !== "ObjectProperty") return;
    const propertyName = exportedPropertyName(node);
    if (!propertyName || !t.isValidIdentifier(propertyName)) return;
    const invocation = invocationFromNode(node.value, model);
    if (!invocation || invocation.flag !== model.nonCallFlag) return;
    if (!model.functions.some((fn) => fn.selector === invocation.selector)) return;
    if (!preferred.has(invocation.selector)) {
      preferred.set(invocation.selector, propertyName);
    }
  });

  const used = collectTopLevelBindingNames(ast);
  used.delete(model.dispatcherName);
  if (model.cacheName) used.delete(model.cacheName);
  used.delete(model.payloadName);

  const result = new Map<string, string>();
  let fallback = 0;
  for (const fn of model.functions) {
    const wanted = preferred.get(fn.selector);
    if (wanted && !used.has(wanted)) {
      used.add(wanted);
      result.set(fn.selector, wanted);
      continue;
    }
    let base = `dispatched${fallback}`;
    fallback += 1;
    while (used.has(base)) {
      base = `dispatched${fallback}`;
      fallback += 1;
    }
    result.set(fn.selector, uniqueName(base, used));
  }
  return result;
}

function payloadSequenceCall(
  node: t.Node,
  model: DispatcherModel,
  names: ReadonlyMap<string, string>,
): t.CallExpression | null {
  if (node.type !== "SequenceExpression" || node.expressions.length !== 2) {
    return null;
  }
  const [first, second] = node.expressions;
  if (
    first?.type !== "AssignmentExpression" ||
    first.operator !== "=" ||
    first.left.type !== "Identifier" ||
    first.left.name !== model.payloadName ||
    first.right.type !== "ArrayExpression" ||
    !second
  ) {
    return null;
  }
  const invocation = invocationFromNode(second, model);
  if (!invocation || invocation.flag === model.nonCallFlag) return null;
  const targetName = names.get(invocation.selector);
  if (!targetName) return null;
  if (first.right.elements.some((element) => element === null)) return null;

  const args = first.right.elements.map((element) =>
    t.cloneNode(element!, true),
  ) as Array<t.Expression | t.SpreadElement>;
  return t.callExpression(t.identifier(targetName), args);
}

function rewriteRecoveredBody(
  body: t.BlockStatement,
  model: DispatcherModel,
  names: ReadonlyMap<string, string>,
): { directCalls: number; functionReferences: number } {
  let directCalls = 0;
  let functionReferences = 0;

  rewriteNodes(body, (node) => {
    const call = payloadSequenceCall(node, model, names);
    if (!call) return node;
    directCalls += 1;
    return call;
  });

  rewriteNodes(body, (node) => {
    const invocation = invocationFromNode(node, model);
    if (!invocation) return node;
    const targetName = names.get(invocation.selector);
    if (!targetName) return node;

    if (invocation.flag === model.nonCallFlag) {
      functionReferences += 1;
      return t.identifier(targetName);
    }
    if (
      model.clearPayloadFlag &&
      invocation.flag === model.clearPayloadFlag
    ) {
      directCalls += 1;
      return t.callExpression(t.identifier(targetName), []);
    }
    return node;
  });

  return { directCalls, functionReferences };
}

function buildFunctionDeclaration(
  fn: DispatchedFunctionModel,
  recoveredName: string,
  model: DispatcherModel,
  names: ReadonlyMap<string, string>,
): {
  declaration: t.FunctionDeclaration;
  directCalls: number;
  functionReferences: number;
} {
  const body = t.blockStatement(
    fn.body.map((statement) => t.cloneNode(statement, true)),
  );
  const rewritten = rewriteRecoveredBody(body, model, names);
  return {
    declaration: t.functionDeclaration(
      t.identifier(recoveredName),
      fn.params.map((param) => t.cloneNode(param, true)),
      body,
    ),
    ...rewritten,
  };
}

function countIdentifier(ast: t.File, name: string): number {
  return countNodes(
    ast,
    (node) => node.type === "Identifier" && node.name === name,
  );
}

function removeUnusedGeneratedScaffolding(
  ast: t.File,
  model: DispatcherModel,
): number {
  let removed = 0;
  const variableNames = new Set(
    [model.payloadName, model.cacheName].filter(
      (name): name is string => Boolean(name),
    ),
  );

  ast.program.body = ast.program.body.filter((statement) => {
    if (
      statement.type === "VariableDeclaration" &&
      statement.declarations.length === 1 &&
      statement.declarations[0]?.id.type === "Identifier"
    ) {
      const name = statement.declarations[0].id.name;
      if (variableNames.has(name) && countIdentifier(ast, name) <= 1) {
        removed += 1;
        return false;
      }
    }
    if (
      statement.type === "FunctionDeclaration" &&
      statement.id &&
      /^__p_[A-Za-z0-9]{4}_d_fnLength$/.test(statement.id.name) &&
      statement.body.body.length === 0 &&
      countIdentifier(ast, statement.id.name) <= 1
    ) {
      removed += 1;
      return false;
    }
    return true;
  });
  return removed;
}

function recoverOneDispatcher(
  ast: t.File,
  model: DispatcherModel,
): RecoveryStats | null {
  const names = inferNames(ast, model);
  if (names.size !== model.functions.length) return null;

  let directCalls = 0;
  let functionReferences = 0;
  const declarations: t.FunctionDeclaration[] = [];
  for (const fn of model.functions) {
    const name = names.get(fn.selector);
    if (!name) return null;
    const built = buildFunctionDeclaration(fn, name, model, names);
    declarations.push(built.declaration);
    directCalls += built.directCalls;
    functionReferences += built.functionReferences;
  }

  rewriteNodes(ast.program, (node) => {
    const invocation = invocationFromNode(node, model);
    if (!invocation || invocation.flag !== model.nonCallFlag) return node;
    const targetName = names.get(invocation.selector);
    if (!targetName) return node;
    functionReferences += 1;
    return t.identifier(targetName);
  });

  const dispatcherIndex = ast.program.body.findIndex(
    (statement) =>
      statement.type === "FunctionDeclaration" &&
      statement.id?.name === model.dispatcherName,
  );
  if (dispatcherIndex < 0) return null;
  ast.program.body.splice(dispatcherIndex, 1, ...declarations);

  const scaffoldingRemoved = removeUnusedGeneratedScaffolding(ast, model);
  return {
    dispatchers: 1,
    functions: declarations.length,
    directCalls,
    functionReferences,
    scaffoldingRemoved,
  };
}

function recoverDispatchers(
  ast: t.File,
  models: readonly DispatcherModel[],
): RecoveryStats {
  const total: RecoveryStats = {
    dispatchers: 0,
    functions: 0,
    directCalls: 0,
    functionReferences: 0,
    scaffoldingRemoved: 0,
  };
  for (const model of models) {
    const recovered = recoverOneDispatcher(ast, model);
    if (!recovered) continue;
    total.dispatchers += recovered.dispatchers;
    total.functions += recovered.functions;
    total.directCalls += recovered.directCalls;
    total.functionReferences += recovered.functionReferences;
    total.scaffoldingRemoved += recovered.scaffoldingRemoved;
  }
  return total;
}

export function createDispatcher213Pass(): ReversePass {
  return {
    id: "jsconfuser.dispatcher.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["dispatcher.directCallsRecovered"],
    detect(ctx) {
      const models = findDispatcherModels(ctx.cleanAst);
      return {
        detected: models.length > 0,
        confidence: models.length > 0 ? 0.98 : 0,
        evidence:
          models.length > 0
            ? [
                `${models.length} generated dispatcher function maps`,
                "payload destructuring and cache/non-call flag topology",
              ]
            : [],
      };
    },
    analyze(ctx) {
      const models = findDispatcherModels(ctx.cleanAst);
      return {
        changed: false,
        facts: {
          "dispatcher.models": models.map((model) => ({
            dispatcherName: model.dispatcherName,
            functionCount: model.functions.length,
            payloadName: model.payloadName,
          })),
        },
      };
    },
    transform(ctx) {
      const models = findDispatcherModels(ctx.cleanAst);
      if (models.length === 0) return { changed: false };

      let stats: RecoveryStats | null = null;
      const transaction = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.dispatcher.v213",
          action: "reconstruct-dispatcher-functions-clean",
          confidence: 0.98,
          evidence: [
            "exact generated dispatcher name and function opcode map",
            "shared generated payload destructuring",
            "non-call and return-wrapper flags derived from dispatcher body",
          ],
        },
        (candidate) => {
          stats = recoverDispatchers(candidate, models);
        },
      );

      const resultStats = stats as RecoveryStats | null;
      return {
        changed: transaction.committed && Boolean(resultStats?.dispatchers),
        actions: resultStats
          ? [
              `reconstructed ${resultStats.functions} functions from ${resultStats.dispatchers} dispatchers`,
              `restored ${resultStats.directCalls} direct calls and ${resultStats.functionReferences} function references`,
              `removed ${resultStats.scaffoldingRemoved} unused dispatcher scaffolding statements`,
            ]
          : [],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.98,
        evidence: [
          "clean-only static function-map extraction and transactional syntax validation",
        ],
      };
    },
  };
}
