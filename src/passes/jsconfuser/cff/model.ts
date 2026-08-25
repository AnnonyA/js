import type * as t from "@babel/types";

export interface Cff213Model {
  sequenceName: string;
  sequence: number[];
  stringsName: string;
  stringsValue: string;
  xorName: string;
  sumName: string;
  sliceName: string;
  mainName: string;
  statesName: string;
  switchStatement: t.SwitchStatement;
  entryStates: number[];
}

function signedNumber(node: t.Node | null | undefined): number | null {
  if (!node) return null;
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

function numericArray(node: t.Node | null | undefined): number[] | null {
  if (!node || node.type !== "ArrayExpression") return null;
  const values: number[] = [];
  for (const element of node.elements) {
    if (!element || element.type === "SpreadElement") return null;
    const value = signedNumber(element);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

function findGeneratedFunction(
  ast: t.File,
  suffix: string,
): t.FunctionDeclaration | null {
  for (const statement of ast.program.body) {
    if (
      statement.type === "FunctionDeclaration" &&
      statement.id &&
      statement.id.name.endsWith(suffix)
    ) {
      return statement;
    }
  }
  return null;
}

function findSequenceAndStrings(ast: t.File): {
  sequenceName: string;
  sequence: number[];
  stringsName: string;
  stringsValue: string;
} | null {
  let sequenceName: string | null = null;
  let sequence: number[] | null = null;
  let stringsName: string | null = null;
  let stringsValue: string | null = null;

  for (const statement of ast.program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== "Identifier" || !declaration.init) continue;
      if (declaration.id.name.endsWith("_cff_sequence")) {
        const values = numericArray(declaration.init);
        if (!values || values.length < 75) return null;
        sequenceName = declaration.id.name;
        sequence = values;
      } else if (
        declaration.id.name.endsWith("_strings") &&
        declaration.init.type === "StringLiteral"
      ) {
        stringsName = declaration.id.name;
        stringsValue = declaration.init.value;
      }
    }
  }

  if (!sequenceName || !sequence || !stringsName || stringsValue === null) {
    return null;
  }
  return { sequenceName, sequence, stringsName, stringsValue };
}

function expandStateArray(
  node: t.Node | null | undefined,
  sequence: readonly number[],
  sliceName: string,
): number[] | null {
  if (!node || node.type !== "ArrayExpression") return null;
  const result: number[] = [];

  for (const element of node.elements) {
    if (!element) return null;
    if (element.type === "SpreadElement") {
      const argument = element.argument;
      if (
        argument.type !== "CallExpression" ||
        argument.callee.type !== "Identifier" ||
        argument.callee.name !== sliceName ||
        argument.arguments.length !== 2
      ) {
        return null;
      }
      const startArg = argument.arguments[0];
      const endArg = argument.arguments[1];
      if (!startArg || !endArg || startArg.type === "SpreadElement" || endArg.type === "SpreadElement") {
        return null;
      }
      const start = signedNumber(startArg);
      const end = signedNumber(endArg);
      if (
        start === null ||
        end === null ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end > sequence.length
      ) {
        return null;
      }
      result.push(...sequence.slice(start, end));
      continue;
    }

    const value = signedNumber(element);
    if (value === null) return null;
    result.push(value);
  }

  return result;
}

function findSwitch(
  main: t.FunctionDeclaration,
  sumName: string,
  statesName: string,
): t.SwitchStatement | null {
  for (const statement of main.body.body) {
    if (statement.type !== "WhileStatement") continue;
    if (statement.body.type !== "BlockStatement") continue;
    for (const inner of statement.body.body) {
      const candidate =
        inner.type === "LabeledStatement" ? inner.body : inner;
      if (candidate.type !== "SwitchStatement") continue;
      if (candidate.discriminant.type !== "CallExpression") continue;
      if (
        candidate.discriminant.callee.type !== "Identifier" ||
        candidate.discriminant.callee.name !== sumName ||
        candidate.discriminant.arguments.length !== 1
      ) {
        continue;
      }
      const argument = candidate.discriminant.arguments[0];
      if (
        argument?.type === "Identifier" &&
        argument.name === statesName
      ) {
        return candidate;
      }
    }
  }
  return null;
}

function findEntryStates(
  ast: t.File,
  mainName: string,
  sequence: readonly number[],
  sliceName: string,
): number[] | null {
  for (const statement of ast.program.body) {
    if (statement.type !== "ExpressionStatement") continue;
    const expression = statement.expression;
    if (
      expression.type !== "CallExpression" ||
      expression.callee.type !== "Identifier" ||
      expression.callee.name !== mainName ||
      expression.arguments.length < 1
    ) {
      continue;
    }
    const first = expression.arguments[0];
    if (!first || first.type === "SpreadElement") continue;
    const values = expandStateArray(first, sequence, sliceName);
    if (values && values.length >= 75) return values;
  }
  return null;
}

export function findCff213Models(ast: t.File): Cff213Model[] {
  const table = findSequenceAndStrings(ast);
  if (!table) return [];

  const xor = findGeneratedFunction(ast, "_cff_xor");
  const sum = findGeneratedFunction(ast, "_cff_sum");
  const slice = findGeneratedFunction(ast, "_cff_slice");
  if (!xor?.id || !sum?.id || !slice?.id) return [];

  const models: Cff213Model[] = [];
  for (const statement of ast.program.body) {
    if (
      statement.type !== "FunctionDeclaration" ||
      !statement.id ||
      !/^__p_[A-Za-z0-9]{4}_\d+_main$/.test(statement.id.name)
    ) {
      continue;
    }
    const states = statement.params[0];
    if (states?.type !== "Identifier") continue;
    const switchStatement = findSwitch(statement, sum.id.name, states.name);
    if (!switchStatement) continue;
    const entryStates = findEntryStates(
      ast,
      statement.id.name,
      table.sequence,
      slice.id.name,
    );
    if (!entryStates) continue;

    models.push({
      ...table,
      xorName: xor.id.name,
      sumName: sum.id.name,
      sliceName: slice.id.name,
      mainName: statement.id.name,
      statesName: states.name,
      switchStatement,
      entryStates,
    });
  }

  return models;
}
