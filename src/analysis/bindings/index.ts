import traverseModule from "@babel/traverse";
import type * as t from "@babel/types";

export interface BindingInfo {
  count: number;
  references: number;
  constant: boolean;
  kinds: string[];
}

export interface BindingSummary {
  bindings: Record<string, BindingInfo>;
}

interface BindingLike {
  referencePaths: unknown[];
  constant: boolean;
  kind: string;
}

interface ScopePathLike {
  scope: {
    bindings: Record<string, BindingLike>;
  };
}

type TraverseFunction = (
  ast: t.Node,
  visitors: Record<string, (path: ScopePathLike) => void>,
) => void;

const moduleValue = traverseModule as unknown as {
  default?: TraverseFunction;
};
const traverse = ((typeof traverseModule === "function"
  ? traverseModule
  : moduleValue.default) ?? traverseModule) as unknown as TraverseFunction;

export function analyzeBindings(ast: t.File): BindingSummary {
  const bindings: Record<string, BindingInfo> = {};
  const seen = new Set<BindingLike>();

  traverse(ast, {
    Scopable(path) {
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (seen.has(binding)) continue;
        seen.add(binding);

        const current = bindings[name] ?? {
          count: 0,
          references: 0,
          constant: true,
          kinds: [],
        };
        current.count += 1;
        current.references += binding.referencePaths.length;
        current.constant = current.constant && binding.constant;
        if (!current.kinds.includes(binding.kind)) current.kinds.push(binding.kind);
        bindings[name] = current;
      }
    },
  });

  return { bindings };
}
