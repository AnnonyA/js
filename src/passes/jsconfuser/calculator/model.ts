import type * as t from "@babel/types";

export type CalculatorOperator = "+" | "-" | "*" | "/";

export interface CalculatorModel {
  functionName: string;
  selectorParameter: string;
  leftParameter: string;
  rightParameter: string;
  operators: Map<string, CalculatorOperator>;
}

const ALLOWED_OPERATORS = new Set<CalculatorOperator>(["+", "-", "*", "/"]);

function readCase(
  switchCase: t.SwitchCase,
  leftParameter: string,
  rightParameter: string,
): [string, CalculatorOperator] | null {
  if (switchCase.test?.type !== "StringLiteral") return null;
  if (switchCase.consequent.length !== 1) return null;
  const statement = switchCase.consequent[0];
  if (statement?.type !== "ReturnStatement") return null;
  const expression = statement.argument;
  if (expression?.type !== "BinaryExpression") return null;
  if (!ALLOWED_OPERATORS.has(expression.operator as CalculatorOperator)) return null;
  if (
    expression.left.type !== "Identifier" ||
    expression.left.name !== leftParameter ||
    expression.right.type !== "Identifier" ||
    expression.right.name !== rightParameter
  ) {
    return null;
  }

  return [switchCase.test.value, expression.operator as CalculatorOperator];
}

export function extractCalculatorModel(
  declaration: t.FunctionDeclaration,
): CalculatorModel | null {
  if (!declaration.id?.name.endsWith("_calc")) return null;
  if (declaration.params.length !== 3) return null;
  if (!declaration.params.every((param) => param.type === "Identifier")) return null;
  if (declaration.body.body.length !== 1) return null;

  const [selector, left, right] = declaration.params as [
    t.Identifier,
    t.Identifier,
    t.Identifier,
  ];
  const statement = declaration.body.body[0];
  if (statement?.type !== "SwitchStatement") return null;
  if (
    statement.discriminant.type !== "Identifier" ||
    statement.discriminant.name !== selector.name
  ) {
    return null;
  }

  const operators = new Map<string, CalculatorOperator>();
  for (const switchCase of statement.cases) {
    const entry = readCase(switchCase, left.name, right.name);
    if (!entry) return null;
    operators.set(entry[0], entry[1]);
  }
  if (operators.size === 0) return null;

  return {
    functionName: declaration.id.name,
    selectorParameter: selector.name,
    leftParameter: left.name,
    rightParameter: right.name,
    operators,
  };
}

export function findCalculatorModels(ast: t.File): CalculatorModel[] {
  const models: CalculatorModel[] = [];
  for (const statement of ast.program.body) {
    if (statement.type !== "FunctionDeclaration") continue;
    const model = extractCalculatorModel(statement);
    if (model) models.push(model);
  }
  return models;
}
