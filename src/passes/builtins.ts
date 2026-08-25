import type { PassRegistry } from "../core/pass.js";
import { createConstantFoldPass } from "./generic/constantFold.js";
import { createCalculator213Pass } from "./jsconfuser/calculator/v213.js";

export function registerBuiltInPasses(registry: PassRegistry): void {
  registry.register(createCalculator213Pass());
  registry.register(createConstantFoldPass());
}
