import type { PassRegistry } from "../core/pass.js";
import { createConstantFoldPass } from "./generic/constantFold.js";
import { createCalculator213Pass } from "./jsconfuser/calculator/v213.js";
import { createDuplicateLiterals213Pass } from "./jsconfuser/extraction/duplicateLiterals.js";
import { createStringConcealing213Pass } from "./jsconfuser/strings/v213.js";

export function registerBuiltInPasses(registry: PassRegistry): void {
  registry.register(createDuplicateLiterals213Pass());
  registry.register(createStringConcealing213Pass());
  registry.register(createCalculator213Pass());
  registry.register(createConstantFoldPass());
}
