import type * as t from "@babel/types";
import { makeEvidence } from "../evidence.js";
import type { FingerprintEvidence } from "../types.js";

interface Profile {
  whileSwitches: number;
  largeNumericArrays: number;
  crossIndexedMutations: number;
  xorStringHelpers: number;
  sumHelpers: number;
  recursiveDispatchers: number;
  helperIdentifiers: Set<string>;
  longStrings: number;
  switchCallDiscriminants: number;
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

function memberPropertyName(node: t.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property.type === "StringLiteral") {
    return node.property.value;
  }
  return null;
}

function containsMemberRead(node: t.Node, objectName: string): boolean {
  let matched = false;
  walk(node, (child) => {
    if (
      child.type === "MemberExpression" &&
      child.computed &&
      child.object.type === "Identifier" &&
      child.object.name === objectName
    ) {
      matched = true;
    }
  });
  return matched;
}

function functionSignals(node: t.FunctionDeclaration): {
  xorString: boolean;
  sumHelper: boolean;
  recursiveDispatcher: boolean;
} {
  const parameterNames = new Set(
    node.params
      .filter((param): param is t.Identifier => param.type === "Identifier")
      .map((param) => param.name),
  );
  let forLoops = 0;
  let whileSwitch = false;
  let charCodeAt = false;
  let fromCharCode = false;
  let bitwise = 0;
  let sumFromParameter = false;
  let recursiveCalls = 0;
  let recursiveCallsWithSpreadArray = 0;

  walk(node.body, (child) => {
    if (child.type === "ForStatement") forLoops += 1;
    if (child.type === "WhileStatement") {
      walk(child.body, (descendant) => {
        if (descendant.type === "SwitchStatement") whileSwitch = true;
      });
    }
    if (child.type === "BinaryExpression") {
      if (["^", "&", "|", ">>", ">>>", "<<", "%"].includes(child.operator)) {
        bitwise += 1;
      }
    }
    if (child.type === "CallExpression" && child.callee.type === "MemberExpression") {
      const property = memberPropertyName(child.callee);
      if (property === "charCodeAt") charCodeAt = true;
      if (
        property === "fromCharCode" &&
        child.callee.object.type === "Identifier" &&
        child.callee.object.name === "String"
      ) {
        fromCharCode = true;
      }
    }
    if (
      child.type === "AssignmentExpression" &&
      child.operator === "+=" &&
      containsMemberRead(child.right, [...parameterNames][0] ?? "")
    ) {
      sumFromParameter = true;
    }
    if (
      node.id &&
      child.type === "CallExpression" &&
      child.callee.type === "Identifier" &&
      child.callee.name === node.id.name
    ) {
      recursiveCalls += 1;
      const first = child.arguments[0];
      if (
        first &&
        first.type === "ArrayExpression" &&
        first.elements.some((element) => element?.type === "SpreadElement")
      ) {
        recursiveCallsWithSpreadArray += 1;
      }
    }
  });

  return {
    xorString:
      node.params.length >= 3 &&
      forLoops > 0 &&
      charCodeAt &&
      fromCharCode &&
      bitwise >= 3,
    sumHelper: parameterNames.size > 0 && forLoops > 0 && sumFromParameter,
    recursiveDispatcher:
      whileSwitch && recursiveCalls > 0 && recursiveCallsWithSpreadArray > 0,
  };
}

function profile(ast: t.File): Profile {
  const result: Profile = {
    whileSwitches: 0,
    largeNumericArrays: 0,
    crossIndexedMutations: 0,
    xorStringHelpers: 0,
    sumHelpers: 0,
    recursiveDispatchers: 0,
    helperIdentifiers: new Set<string>(),
    longStrings: 0,
    switchCallDiscriminants: 0,
  };

  walk(ast, (node) => {
    if (node.type === "Identifier" && node.name.startsWith("__p_")) {
      result.helperIdentifiers.add(node.name);
    }
    if (node.type === "StringLiteral" && node.value.length >= 256) {
      result.longStrings += 1;
    }
    if (node.type === "ArrayExpression") {
      const numeric = node.elements.filter(
        (element) => element?.type === "NumericLiteral",
      ).length;
      if (node.elements.length >= 32 && numeric / node.elements.length >= 0.85) {
        result.largeNumericArrays += 1;
      }
    }
    if (node.type === "WhileStatement") {
      let hasSwitch = false;
      walk(node.body, (child) => {
        if (child.type === "SwitchStatement") hasSwitch = true;
      });
      if (hasSwitch) result.whileSwitches += 1;
    }
    if (
      node.type === "SwitchStatement" &&
      node.discriminant.type === "CallExpression"
    ) {
      result.switchCallDiscriminants += 1;
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      node.left.computed &&
      node.left.object.type === "Identifier" &&
      containsMemberRead(node.right, node.left.object.name)
    ) {
      result.crossIndexedMutations += 1;
    }
    if (node.type === "FunctionDeclaration") {
      const signals = functionSignals(node);
      if (signals.xorString) result.xorStringHelpers += 1;
      if (signals.sumHelper) result.sumHelpers += 1;
      if (signals.recursiveDispatcher) result.recursiveDispatchers += 1;
    }
  });

  return result;
}

export function collectBabel213Evidence(ast: t.File): FingerprintEvidence[] {
  const p = profile(ast);
  const simpleStateMachine =
    p.whileSwitches > 0 &&
    p.largeNumericArrays === 0 &&
    p.crossIndexedMutations === 0 &&
    p.recursiveDispatchers === 0;

  return [
    makeEvidence(
      "cff.whileSwitch",
      0.6,
      p.whileSwitches > 0,
      `${p.whileSwitches} while/switch dispatcher candidates`,
    ),
    makeEvidence(
      "cff.largeNumericStateArray",
      1.3,
      p.largeNumericArrays > 0,
      `${p.largeNumericArrays} large numeric arrays`,
    ),
    makeEvidence(
      "cff.crossIndexedStateMutation",
      1.5,
      p.crossIndexedMutations >= 3,
      `${p.crossIndexedMutations} cross-indexed state mutations`,
    ),
    makeEvidence(
      "cff.stateStringXorHelper",
      1.5,
      p.xorStringHelpers > 0,
      `${p.xorStringHelpers} XOR/string helper candidates`,
    ),
    makeEvidence(
      "cff.stateSumHelper",
      1.1,
      p.sumHelpers > 0,
      `${p.sumHelpers} state sum helper candidates`,
    ),
    makeEvidence(
      "cff.recursiveDispatcher",
      1.8,
      p.recursiveDispatchers > 0,
      `${p.recursiveDispatchers} recursive dispatcher candidates`,
    ),
    makeEvidence(
      "cff.callDiscriminant",
      0.8,
      p.switchCallDiscriminants > 0,
      `${p.switchCallDiscriminants} switch discriminants are calls`,
    ),
    makeEvidence(
      "jsconfuser.helperCluster",
      0.6,
      p.helperIdentifiers.size >= 5,
      `${p.helperIdentifiers.size} generated helper identifiers`,
    ),
    makeEvidence(
      "jsconfuser.longEncodedTable",
      0.5,
      p.longStrings > 0,
      `${p.longStrings} long encoded string tables`,
    ),
    makeEvidence(
      "generic.simpleStateMachine",
      -1.8,
      simpleStateMachine,
      simpleStateMachine
        ? "state machine lacks js-confuser state-array/helper topology"
        : "not a simple standalone state machine",
    ),
  ];
}
