import * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import { runAstTransaction } from "../../../core/transaction.js";
import { parseJavaScript } from "../../../parser/parse.js";
import { countNodes, rewriteNodes } from "../../rewrite.js";

interface RgfPayload {
  params: t.FunctionDeclaration["params"];
  body: t.BlockStatement;
}

interface RgfStub {
  node: t.FunctionDeclaration | t.FunctionExpression;
  index: number;
}

interface RgfModel {
  arrayName: string;
  evalName: string;
  arrayStatement: t.VariableDeclaration;
  payloads: RgfPayload[];
  stubs: RgfStub[];
  evalHelper: t.FunctionDeclaration;
  integrityName: string | null;
  integrityStatement: t.VariableDeclaration | null;
  integrityFactoryName: string | null;
  integrityFactory: t.FunctionDeclaration | null;
}

function staticProperty(node: t.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "StringLiteral") return node.property.value;
  return null;
}

function extractPayload(code: string, arrayName: string): RgfPayload | null {
  let ast: t.File;
  try {
    ast = parseJavaScript(code, "<js-confuser-rgf>");
  } catch {
    return null;
  }

  const body = ast.program.body;
  if (body.length !== 2) return null;
  const embedded = body[0];
  const tail = body[1];
  if (
    embedded?.type !== "FunctionDeclaration" ||
    !embedded.id ||
    tail?.type !== "ExpressionStatement" ||
    tail.expression.type !== "Identifier" ||
    tail.expression.name !== embedded.id.name
  ) {
    return null;
  }

  const statements = embedded.body.body;
  if (statements.length !== 3) return null;
  const setup = statements[0];
  const replacement = statements[1];
  const returned = statements[2];
  if (
    setup?.type !== "VariableDeclaration" ||
    setup.declarations.length !== 1 ||
    replacement?.type !== "FunctionDeclaration" ||
    !replacement.id ||
    returned?.type !== "ReturnStatement" ||
    !returned.argument
  ) {
    return null;
  }

  const declarator = setup.declarations[0];
  if (
    declarator?.id.type !== "ArrayPattern" ||
    declarator.id.elements.length !== 2 ||
    declarator.init?.type !== "Identifier" ||
    declarator.init.name !== "arguments"
  ) {
    return null;
  }
  const [arrayElement, argsElement] = declarator.id.elements;
  if (
    arrayElement?.type !== "Identifier" ||
    arrayElement.name !== arrayName ||
    argsElement?.type !== "Identifier"
  ) {
    return null;
  }

  const call = returned.argument;
  if (
    call.type !== "CallExpression" ||
    call.callee.type !== "MemberExpression" ||
    staticProperty(call.callee) !== "apply" ||
    call.callee.object.type !== "Identifier" ||
    call.callee.object.name !== replacement.id.name ||
    call.arguments.length !== 2 ||
    call.arguments[0]?.type !== "ThisExpression" ||
    call.arguments[1]?.type !== "Identifier" ||
    call.arguments[1].name !== argsElement.name
  ) {
    return null;
  }

  return {
    params: replacement.params.map((param) => t.cloneNode(param, true)),
    body: t.cloneNode(replacement.body, true),
  };
}

function rgfStubIndex(
  node: t.FunctionDeclaration | t.FunctionExpression,
  arrayName: string,
): number | null {
  if (node.params.length !== 0 || node.body.body.length !== 1) return null;
  const statement = node.body.body[0];
  if (statement?.type !== "ReturnStatement" || !statement.argument) return null;
  const call = statement.argument;
  if (
    call.type !== "CallExpression" ||
    call.callee.type !== "MemberExpression" ||
    staticProperty(call.callee) !== "apply" ||
    call.callee.object.type !== "MemberExpression" ||
    call.arguments.length !== 2 ||
    call.arguments[0]?.type !== "ThisExpression" ||
    call.arguments[1]?.type !== "ArrayExpression"
  ) {
    return null;
  }

  const indexed = call.callee.object;
  if (
    indexed.object.type !== "Identifier" ||
    indexed.object.name !== arrayName ||
    !indexed.computed ||
    indexed.property.type !== "NumericLiteral" ||
    !Number.isInteger(indexed.property.value) ||
    indexed.property.value < 0
  ) {
    return null;
  }

  const args = call.arguments[1].elements;
  if (
    args.length !== 2 ||
    args[0]?.type !== "Identifier" ||
    args[0].name !== arrayName ||
    args[1]?.type !== "Identifier" ||
    args[1].name !== "arguments"
  ) {
    return null;
  }
  return indexed.property.value;
}

function evalIntegrityName(helper: t.FunctionDeclaration): string | null {
  if (helper.params.length !== 1 || helper.params[0]?.type !== "Identifier") return null;
  const codeName = helper.params[0].name;
  let integrityName: string | null = null;
  let evalReturn = false;
  rewriteNodes(helper.body, (node) => {
    if (node.type === "IfStatement" && node.test.type === "Identifier") {
      integrityName ??= node.test.name;
    }
    if (
      node.type === "ReturnStatement" &&
      node.argument?.type === "CallExpression" &&
      node.argument.callee.type === "Identifier" &&
      node.argument.callee.name === "eval" &&
      node.argument.arguments.length === 1 &&
      node.argument.arguments[0]?.type === "Identifier" &&
      node.argument.arguments[0].name === codeName
    ) {
      evalReturn = true;
    }
    return node;
  });
  return evalReturn ? integrityName : null;
}

function findIntegrityStatement(
  ast: t.File,
  integrityName: string,
): { statement: t.VariableDeclaration; factoryName: string } | null {
  for (const statement of ast.program.body) {
    if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) continue;
    const declarator = statement.declarations[0];
    if (
      declarator?.id.type !== "Identifier" ||
      declarator.id.name !== integrityName ||
      declarator.init?.type !== "CallExpression" ||
      declarator.init.callee.type !== "Identifier" ||
      declarator.init.arguments.length !== 0
    ) {
      continue;
    }
    return { statement, factoryName: declarator.init.callee.name };
  }
  return null;
}

function findRgfModel(ast: t.File): RgfModel | null {
  for (const statement of ast.program.body) {
    if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) continue;
    const declarator = statement.declarations[0];
    if (declarator?.id.type !== "Identifier" || declarator.init?.type !== "ArrayExpression") continue;
    if (declarator.init.elements.length === 0) continue;
    const arrayName = declarator.id.name;

    let evalName: string | null = null;
    const payloads: RgfPayload[] = [];
    let valid = true;
    for (const element of declarator.init.elements) {
      if (
        !element ||
        element.type !== "CallExpression" ||
        element.callee.type !== "Identifier" ||
        element.arguments.length !== 1 ||
        element.arguments[0]?.type !== "StringLiteral"
      ) {
        valid = false;
        break;
      }
      evalName ??= element.callee.name;
      if (evalName !== element.callee.name) {
        valid = false;
        break;
      }
      const payload = extractPayload(element.arguments[0].value, arrayName);
      if (!payload) {
        valid = false;
        break;
      }
      payloads.push(payload);
    }
    if (!valid || !evalName || payloads.length === 0) continue;

    const evalHelper = ast.program.body.find(
      (candidate): candidate is t.FunctionDeclaration =>
        candidate.type === "FunctionDeclaration" && candidate.id?.name === evalName,
    );
    if (!evalHelper) continue;
    const integrityName = evalIntegrityName(evalHelper);
    if (!integrityName) continue;

    const stubs: RgfStub[] = [];
    rewriteNodes(ast, (node) => {
      if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
        if (node === evalHelper) return node;
        const index = rgfStubIndex(node, arrayName);
        if (index !== null) stubs.push({ node, index });
      }
      return node;
    });

    if (stubs.length !== payloads.length) continue;
    const indices = new Set(stubs.map((stub) => stub.index));
    if (
      indices.size !== payloads.length ||
      [...indices].some((index) => index < 0 || index >= payloads.length)
    ) {
      continue;
    }

    const integrity = findIntegrityStatement(ast, integrityName);
    const integrityFactory = integrity
      ? ast.program.body.find(
          (candidate): candidate is t.FunctionDeclaration =>
            candidate.type === "FunctionDeclaration" && candidate.id?.name === integrity.factoryName,
        ) ?? null
      : null;

    return {
      arrayName,
      evalName,
      arrayStatement: statement,
      payloads,
      stubs,
      evalHelper,
      integrityName,
      integrityStatement: integrity?.statement ?? null,
      integrityFactoryName: integrity?.factoryName ?? null,
      integrityFactory,
    };
  }
  return null;
}

function identifierCount(ast: t.File, name: string): number {
  return countNodes(ast, (node) => node.type === "Identifier" && node.name === name);
}

function removeProgramStatement(ast: t.File, target: t.Statement): void {
  ast.program.body = ast.program.body.filter((statement) => statement !== target);
}

function recoverRgf(ast: t.File): number {
  const model = findRgfModel(ast);
  if (!model) return 0;

  for (const stub of model.stubs) {
    const payload = model.payloads[stub.index];
    if (!payload) return 0;
    stub.node.params = payload.params.map((param) => t.cloneNode(param, true));
    stub.node.body = t.cloneNode(payload.body, true);
  }

  if (identifierCount(ast, model.arrayName) === 1) {
    removeProgramStatement(ast, model.arrayStatement);
  }
  if (identifierCount(ast, model.evalName) === 1) {
    removeProgramStatement(ast, model.evalHelper);
  }
  if (
    model.integrityName &&
    model.integrityStatement &&
    identifierCount(ast, model.integrityName) === 1
  ) {
    removeProgramStatement(ast, model.integrityStatement);
  }
  if (
    model.integrityFactoryName &&
    model.integrityFactory &&
    identifierCount(ast, model.integrityFactoryName) === 1
  ) {
    removeProgramStatement(ast, model.integrityFactory);
  }
  return model.stubs.length;
}

export function createRgf213Pass(): ReversePass {
  return {
    id: "jsconfuser.rgf.v213",
    prerequisites: [],
    conflicts: [],
    capabilities: ["rgf.recovered"],
    detect(ctx) {
      const model = findRgfModel(ctx.cleanAst);
      return {
        detected: Boolean(model),
        confidence: model ? 0.995 : 0,
        evidence: model
          ? [
              `${model.payloads.length} RGF payload string(s) map one-to-one to outer function stubs`,
              "embedded wrapper destructures [rgfArray, arguments] and delegates to a replacement function via apply",
            ]
          : [],
      };
    },
    analyze(ctx) {
      const model = findRgfModel(ctx.cleanAst);
      return {
        changed: false,
        facts: model
          ? {
              "rgf.model": {
                arrayName: model.arrayName,
                evalName: model.evalName,
                functions: model.payloads.length,
              },
            }
          : {},
      };
    },
    transform(ctx) {
      if (!findRgfModel(ctx.cleanAst)) return { changed: false };

      let cleanCount = 0;
      const clean = runAstTransaction(
        ctx,
        "clean",
        {
          passId: "jsconfuser.rgf.v213",
          action: "recover-runtime-generated-functions-clean",
          confidence: 0.995,
          evidence: [
            "RGF payloads are static string literals and are parsed without executing eval",
            "each payload index is linked to exactly one structurally verified outer stub",
          ],
        },
        (candidate) => {
          cleanCount = recoverRgf(candidate);
        },
      );

      let safeCount = 0;
      const safe = runAstTransaction(
        ctx,
        "safe",
        {
          passId: "jsconfuser.rgf.v213",
          action: "recover-runtime-generated-functions-safe",
          confidence: 0.995,
          evidence: [
            "static RGF wrapper topology proves original params/body without executing untrusted code",
          ],
        },
        (candidate) => {
          safeCount = recoverRgf(candidate);
        },
      );

      const changed =
        (clean.committed && cleanCount > 0) ||
        (safe.committed && safeCount > 0);
      return {
        changed,
        actions: changed
          ? [`recovered ${Math.max(cleanCount, safeCount)} runtime-generated function(s)`]
          : [],
      };
    },
    verify(_ctx, result) {
      return {
        valid: true,
        confidence: result.changed ? 0.995 : 0.99,
        evidence: ["RGF recovery committed through syntax-validated AST transactions"],
      };
    },
  };
}
