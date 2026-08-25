import type * as t from "@babel/types";
import type { ReversePass } from "../../../core/pass.js";
import {
  expandCffStateArray,
  findCff213Models,
  type Cff213Model,
} from "./model.js";

export interface ExportedCffWrapperModel {
  exportName: string;
  scopePath: string[];
  states: number[];
  entrySum: number;
}

interface ExportReference {
  exportName: string;
  scopePath: string[];
}

interface WrapperReportRecord {
  exportName: string;
  scopePath: string[];
  stateCount: number;
  entrySum: number;
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

function staticPropertyName(member: t.MemberExpression): string | null {
  if (member.computed) {
    return member.property.type === "StringLiteral" ? member.property.value : null;
  }
  return member.property.type === "Identifier" ? member.property.name : null;
}

function memberPathFromRoot(node: t.Node, rootName: string): string[] | null {
  if (node.type === "Identifier") {
    return node.name === rootName ? [] : null;
  }
  if (node.type !== "MemberExpression") return null;
  const parent = memberPathFromRoot(node.object, rootName);
  if (!parent) return null;
  const property = staticPropertyName(node);
  if (property === null) return null;
  return [...parent, property];
}

function objectPropertyName(property: t.ObjectProperty): string | null {
  if (property.key.type === "StringLiteral") return property.key.value;
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }
  return null;
}

function isModuleExportsMember(member: t.MemberExpression): boolean {
  if (member.object.type !== "Identifier" || member.object.name !== "module") {
    return false;
  }
  if (member.computed) {
    return member.property.type === "StringLiteral" && member.property.value === "exports";
  }
  return member.property.type === "Identifier" && member.property.name === "exports";
}

function findExportReferences(
  ast: t.File,
  model: Cff213Model,
): ExportReference[] | null {
  const candidates: ExportReference[][] = [];

  visitNodes(ast.program, (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "MemberExpression" ||
      !isModuleExportsMember(node.left) ||
      node.right.type !== "ObjectExpression"
    ) {
      return;
    }

    const references: ExportReference[] = [];
    for (const property of node.right.properties) {
      if (property.type !== "ObjectProperty") return;
      const exportName = objectPropertyName(property);
      if (!exportName || property.value.type !== "MemberExpression") return;
      const scopePath = memberPathFromRoot(property.value, model.scopeName);
      if (!scopePath || scopePath.length === 0) return;
      references.push({ exportName, scopePath });
    }

    if (references.length > 0) candidates.push(references);
  });

  return candidates.length === 1 ? candidates[0]! : null;
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function wrapperStates(
  fn: t.FunctionExpression | t.ArrowFunctionExpression,
  model: Cff213Model,
): number[] | null {
  if (fn.params.length !== 1 || fn.params[0]?.type !== "RestElement") return null;
  if (fn.params[0].argument.type !== "Identifier") return null;
  const argsName = fn.params[0].argument.name;
  if (fn.body.type !== "BlockStatement" || fn.body.body.length !== 1) return null;

  const statement = fn.body.body[0];
  if (statement?.type !== "ReturnStatement" || statement.argument?.type !== "CallExpression") {
    return null;
  }
  const call = statement.argument;
  if (
    call.callee.type !== "Identifier" ||
    call.callee.name !== model.mainName ||
    call.arguments.length < 4
  ) {
    return null;
  }
  const first = call.arguments[0];
  const last = call.arguments.at(-1);
  if (!first || first.type === "SpreadElement" || !last || last.type !== "Identifier") {
    return null;
  }
  if (last.name !== argsName) return null;

  const states = expandCffStateArray(first, model.sequence, model.sliceName);
  if (!states || states.length < 75) return null;
  return states;
}

function findWrapperStates(
  ast: t.File,
  model: Cff213Model,
  scopePath: readonly string[],
): number[] | null {
  const matches: number[][] = [];

  visitNodes(ast.program, (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "MemberExpression" ||
      (node.right.type !== "FunctionExpression" &&
        node.right.type !== "ArrowFunctionExpression")
    ) {
      return;
    }
    const candidatePath = memberPathFromRoot(node.left, model.scopeName);
    if (!candidatePath || !pathsEqual(candidatePath, scopePath)) return;
    const states = wrapperStates(node.right, model);
    if (states) matches.push(states);
  });

  return matches.length === 1 ? matches[0]! : null;
}

function modelKey(value: { exportName: string; scopePath: readonly string[] }): string {
  return `${value.exportName}\u0000${value.scopePath.join("\u0000")}`;
}

function isWrapperModel(value: unknown): value is ExportedCffWrapperModel {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ExportedCffWrapperModel>;
  return typeof record.exportName === "string" &&
    Array.isArray(record.scopePath) &&
    record.scopePath.every((part) => typeof part === "string") &&
    Array.isArray(record.states) &&
    record.states.every((part) => typeof part === "number") &&
    typeof record.entrySum === "number";
}

function isWrapperReport(value: unknown): value is WrapperReportRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WrapperReportRecord>;
  return typeof record.exportName === "string" &&
    Array.isArray(record.scopePath) &&
    record.scopePath.every((part) => typeof part === "string") &&
    typeof record.stateCount === "number" &&
    typeof record.entrySum === "number";
}

function mergeModels(
  previous: unknown,
  current: readonly ExportedCffWrapperModel[],
): ExportedCffWrapperModel[] {
  const merged = new Map<string, ExportedCffWrapperModel>();
  if (Array.isArray(previous)) {
    for (const item of previous) {
      if (isWrapperModel(item)) {
        merged.set(modelKey(item), {
          exportName: item.exportName,
          scopePath: [...item.scopePath],
          states: [...item.states],
          entrySum: item.entrySum,
        });
      }
    }
  }
  for (const item of current) {
    merged.set(modelKey(item), {
      exportName: item.exportName,
      scopePath: [...item.scopePath],
      states: [...item.states],
      entrySum: item.entrySum,
    });
  }
  return [...merged.values()];
}

function mergeReport(
  previous: unknown,
  current: readonly ExportedCffWrapperModel[],
): WrapperReportRecord[] {
  const merged = new Map<string, WrapperReportRecord>();
  if (Array.isArray(previous)) {
    for (const item of previous) {
      if (isWrapperReport(item)) {
        merged.set(modelKey(item), {
          exportName: item.exportName,
          scopePath: [...item.scopePath],
          stateCount: item.stateCount,
          entrySum: item.entrySum,
        });
      }
    }
  }
  for (const item of current) {
    merged.set(modelKey(item), {
      exportName: item.exportName,
      scopePath: [...item.scopePath],
      stateCount: item.states.length,
      entrySum: item.entrySum,
    });
  }
  return [...merged.values()];
}

export function findExportedCffWrapperModels(
  ast: t.File,
): ExportedCffWrapperModel[] {
  const cffModels = findCff213Models(ast);
  if (cffModels.length !== 1) return [];
  const cff = cffModels[0]!;
  const references = findExportReferences(ast, cff);
  if (!references) return [];

  const wrappers: ExportedCffWrapperModel[] = [];
  for (const reference of references) {
    const states = findWrapperStates(ast, cff, reference.scopePath);
    if (!states) continue;
    wrappers.push({
      exportName: reference.exportName,
      scopePath: reference.scopePath,
      states,
      entrySum: states.reduce((sum, value) => sum + value, 0),
    });
  }
  return wrappers;
}

export function createCffWrapperModelPass(): ReversePass {
  return {
    id: "jsconfuser.cff-wrapper-models",
    prerequisites: ["cff.exportsDecoded"],
    conflicts: [],
    capabilities: ["cff.wrappersModeled"],
    detect(ctx) {
      const wrappers = findExportedCffWrapperModels(ctx.cleanAst);
      return {
        detected: wrappers.length > 0,
        confidence: wrappers.length > 0 ? 0.995 : 0,
        evidence:
          wrappers.length > 0
            ? [
                `${wrappers.length} exported CFF wrappers linked through generated scope paths`,
                "each wrapper recursively calls the generated CFF main with a concrete expanded state vector",
              ]
            : [],
      };
    },
    analyze(ctx) {
      const wrappers = findExportedCffWrapperModels(ctx.cleanAst);
      const merged = mergeModels(ctx.facts.get("cff.exportedWrappers"), wrappers);
      return {
        changed: false,
        facts: merged.length ? { "cff.exportedWrappers": merged } : {},
      };
    },
    transform(ctx) {
      const wrappers = findExportedCffWrapperModels(ctx.cleanAst);
      if (wrappers.length === 0) return { changed: false };

      ctx.report.recovery.cffWrappers = mergeReport(
        ctx.report.recovery.cffWrappers,
        wrappers,
      );

      return {
        changed: false,
        actions: [`modeled ${wrappers.length} exported CFF wrapper entry states`],
      };
    },
    verify() {
      return {
        valid: true,
        confidence: 0.995,
        evidence: [
          "export value, generated scope assignment, recursive main call, and expanded state vector agree structurally",
        ],
      };
    },
  };
}
