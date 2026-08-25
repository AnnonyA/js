import type * as t from "@babel/types";

export interface GlobalConcealingModel {
  functionName: string;
  globalVarName: string;
  globalVarResolverName: string | null;
  mappings: Map<string, string>;
}

function generatedName(name: string, suffix: string): boolean {
  return new RegExp(`^__p_[A-Za-z0-9]{4}_${suffix}$`).test(name);
}

function findGlobalVarResolver(
  ast: t.File,
  globalVarName: string,
): string | null {
  for (const statement of ast.program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    if (statement.declarations.length !== 1) continue;
    const declaration = statement.declarations[0];
    if (declaration?.id.type !== "Identifier") continue;
    if (declaration.id.name !== globalVarName) continue;
    if (declaration.init?.type !== "CallExpression") return null;
    if (declaration.init.arguments.length !== 0) return null;
    if (declaration.init.callee.type !== "Identifier") return null;
    if (!generatedName(declaration.init.callee.name, "getGlobalVarFn")) return null;
    return declaration.init.callee.name;
  }
  return null;
}

export function findGlobalConcealingModels(ast: t.File): GlobalConcealingModel[] {
  const models: GlobalConcealingModel[] = [];

  for (const statement of ast.program.body) {
    if (statement.type !== "FunctionDeclaration" || !statement.id) continue;
    if (!generatedName(statement.id.name, "getGlobal")) continue;
    if (statement.params.length !== 1 || statement.params[0]?.type !== "Identifier") {
      continue;
    }

    const parameterName = statement.params[0].name;
    const switches = statement.body.body.filter(
      (child): child is t.SwitchStatement => child.type === "SwitchStatement",
    );
    if (switches.length !== 1) continue;
    const switchStatement = switches[0];
    if (
      switchStatement.discriminant.type !== "Identifier" ||
      switchStatement.discriminant.name !== parameterName ||
      switchStatement.cases.length < 10
    ) {
      continue;
    }

    let globalVarName: string | null = null;
    const mappings = new Map<string, string>();
    let valid = true;

    for (const switchCase of switchStatement.cases) {
      if (switchCase.test?.type !== "StringLiteral") {
        valid = false;
        break;
      }
      if (switchCase.consequent.length !== 1) {
        valid = false;
        break;
      }
      const returnStatement = switchCase.consequent[0];
      if (
        returnStatement?.type !== "ReturnStatement" ||
        returnStatement.argument?.type !== "MemberExpression" ||
        !returnStatement.argument.computed ||
        returnStatement.argument.object.type !== "Identifier" ||
        returnStatement.argument.property.type !== "StringLiteral"
      ) {
        valid = false;
        break;
      }

      const caseGlobalVar = returnStatement.argument.object.name;
      if (!generatedName(caseGlobalVar, "globalVar")) {
        valid = false;
        break;
      }
      if (globalVarName === null) globalVarName = caseGlobalVar;
      if (globalVarName !== caseGlobalVar) {
        valid = false;
        break;
      }
      mappings.set(switchCase.test.value, returnStatement.argument.property.value);
    }

    if (!valid || !globalVarName || mappings.size !== switchStatement.cases.length) {
      continue;
    }

    models.push({
      functionName: statement.id.name,
      globalVarName,
      globalVarResolverName: findGlobalVarResolver(ast, globalVarName),
      mappings,
    });
  }

  return models;
}
