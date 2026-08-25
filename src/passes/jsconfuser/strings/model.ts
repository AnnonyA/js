import type * as t from "@babel/types";

export const UNKNOWN_VALUE = Symbol("UnknownValue");
export type UnknownValue = typeof UNKNOWN_VALUE;

export interface DecoderModel {
  wrapperName: string;
  decoderName: string;
  stringsName: string;
  table: string;
  blob: string;
  decodeStatic(args: readonly unknown[]): unknown | UnknownValue;
}

function isNode(value: unknown): value is t.Node {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

function walk(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node);
  for (const value of Object.values(node as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function propertyName(node: t.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property.type === "StringLiteral") {
    return node.property.value;
  }
  return null;
}

function decoderTable(fn: t.FunctionDeclaration): string | null {
  if (!fn.id?.name.endsWith("_decode") || fn.params.length !== 1) return null;

  let tableName: string | null = null;
  let table: string | null = null;
  let hasIndexOf = false;
  const numbers = new Set<number>();
  let bitwiseOperations = 0;

  walk(fn.body, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "StringLiteral" &&
      node.init.value.length === 91 &&
      new Set(node.init.value).size === 91
    ) {
      tableName = node.id.name;
      table = node.init.value;
    }
    if (node.type === "NumericLiteral") numbers.add(node.value);
    if (
      node.type === "BinaryExpression" &&
      ["&", "|", "<<", ">>", ">>>"].includes(node.operator)
    ) {
      bitwiseOperations += 1;
    }
  });

  if (!tableName || !table) return null;

  walk(fn.body, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === tableName &&
      propertyName(node.callee) === "indexOf"
    ) {
      hasIndexOf = true;
    }
  });

  if (
    !hasIndexOf ||
    !numbers.has(91) ||
    !numbers.has(8191) ||
    !numbers.has(255) ||
    bitwiseOperations < 5
  ) {
    return null;
  }

  return table;
}

interface WrapperShape {
  wrapperName: string;
  decoderName: string;
  stringsName: string;
}

function extractWrapper(fn: t.FunctionDeclaration): WrapperShape | null {
  if (!fn.id || fn.params.length !== 2 || fn.body.body.length !== 1) return null;
  const [start, length] = fn.params;
  if (start?.type !== "Identifier" || length?.type !== "Identifier") return null;

  const statement = fn.body.body[0];
  if (statement?.type !== "ReturnStatement") return null;
  const outer = statement.argument;
  if (
    outer?.type !== "CallExpression" ||
    outer.callee.type !== "Identifier" ||
    outer.arguments.length !== 1
  ) {
    return null;
  }
  const sliceCall = outer.arguments[0];
  if (
    !sliceCall ||
    sliceCall.type !== "CallExpression" ||
    sliceCall.callee.type !== "MemberExpression" ||
    sliceCall.callee.object.type !== "Identifier" ||
    propertyName(sliceCall.callee) !== "slice" ||
    sliceCall.arguments.length !== 2
  ) {
    return null;
  }

  const [sliceStart, sliceEnd] = sliceCall.arguments;
  if (
    sliceStart?.type !== "Identifier" ||
    sliceStart.name !== start.name ||
    sliceEnd?.type !== "BinaryExpression" ||
    sliceEnd.operator !== "+" ||
    sliceEnd.left.type !== "Identifier" ||
    sliceEnd.left.name !== start.name ||
    sliceEnd.right.type !== "Identifier" ||
    sliceEnd.right.name !== length.name
  ) {
    return null;
  }

  return {
    wrapperName: fn.id.name,
    decoderName: outer.callee.name,
    stringsName: sliceCall.callee.object.name,
  };
}

function decodeBase91(encoded: string, table: string): string {
  const bytes: number[] = [];
  let b = 0;
  let n = 0;
  let v = -1;

  for (const character of encoded) {
    const p = table.indexOf(character);
    if (p === -1) continue;
    if (v < 0) {
      v = p;
      continue;
    }

    v += p * 91;
    b |= v << n;
    n += (v & 8191) > 88 ? 13 : 14;
    do {
      bytes.push(b & 255);
      b >>= 8;
      n -= 8;
    } while (n > 7);
    v = -1;
  }

  if (v > -1) bytes.push((b | (v << n)) & 255);
  return Buffer.from(bytes).toString("utf8");
}

function staticDecoder(
  blob: string,
  table: string,
): (args: readonly unknown[]) => unknown | UnknownValue {
  return (args) => {
    if (args.length !== 2) return UNKNOWN_VALUE;
    const [start, length] = args;
    if (
      typeof start !== "number" ||
      typeof length !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(length) ||
      start < 0 ||
      length < 0 ||
      start + length > blob.length
    ) {
      return UNKNOWN_VALUE;
    }

    return decodeBase91(blob.slice(start, start + length), table);
  };
}

export function findDecoderModels(ast: t.File): DecoderModel[] {
  const blobs = new Map<string, string>();
  const decoders = new Map<string, string>();
  const wrappers: WrapperShape[] = [];

  walk(ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "StringLiteral" &&
      node.init.value.length >= 100
    ) {
      blobs.set(node.id.name, node.init.value);
    }
    if (node.type === "FunctionDeclaration") {
      const table = decoderTable(node);
      if (table && node.id) decoders.set(node.id.name, table);
      const wrapper = extractWrapper(node);
      if (wrapper) wrappers.push(wrapper);
    }
  });

  const models: DecoderModel[] = [];
  for (const wrapper of wrappers) {
    const table = decoders.get(wrapper.decoderName);
    const blob = blobs.get(wrapper.stringsName);
    if (!table || blob === undefined) continue;

    models.push({
      ...wrapper,
      table,
      blob,
      decodeStatic: staticDecoder(blob, table),
    });
  }
  return models;
}
