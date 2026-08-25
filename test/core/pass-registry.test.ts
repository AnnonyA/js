import { expect, it } from "vitest";
import {
  PassRegistry,
  type ReversePass,
} from "../../src/core/pass.js";

function fakePass(id: string, capabilities: string[] = []): ReversePass {
  return {
    id,
    prerequisites: [],
    conflicts: [],
    capabilities,
    detect: () => ({ detected: true, confidence: 1, evidence: [] }),
    analyze: () => ({ changed: false }),
    transform: () => ({ changed: false }),
    verify: () => ({ valid: true, confidence: 1, evidence: [] }),
  };
}

it("rejects duplicate pass ids", () => {
  const registry = new PassRegistry();
  registry.register(fakePass("x"));
  expect(() => registry.register(fakePass("x"))).toThrow(/duplicate pass id/i);
});

it("finds registered passes by capability in registration order", () => {
  const registry = new PassRegistry();
  registry.register(fakePass("first", ["strings.decode"]));
  registry.register(fakePass("other", ["cfg.recover"]));
  registry.register(fakePass("second", ["strings.decode"]));

  expect(registry.byCapability("strings.decode").map((pass) => pass.id)).toEqual([
    "first",
    "second",
  ]);
});
