import type { PassRegistry } from "../core/pass.js";
import { createConstantFoldPass } from "./generic/constantFold.js";
import { createCalculator213Pass } from "./jsconfuser/calculator/v213.js";
import { createCffBody213Pass } from "./jsconfuser/cff/body213.js";
import { createCffTwiceBody213Pass } from "./jsconfuser/cff/bodyTwice213.js";
import { createCffExportAliasesPass } from "./jsconfuser/cff/exportAliases.js";
import { createControlFlowFlattening213Pass } from "./jsconfuser/cff/v213.js";
import { createCffWrapperModelPass } from "./jsconfuser/cff/wrappers.js";
import { createDispatcher213Pass } from "./jsconfuser/dispatcher/v213.js";
import { createDuplicateLiterals213Pass } from "./jsconfuser/extraction/duplicateLiterals.js";
import { createObjectExtraction213Pass } from "./jsconfuser/extraction/objectExtraction.js";
import { createGlobalConcealing213Pass } from "./jsconfuser/globals/v213.js";
import { createStringConcealing213Pass } from "./jsconfuser/strings/v213.js";
import { createVariableMasking213Pass } from "./jsconfuser/variableMasking/v213.js";

export function registerBuiltInPasses(registry: PassRegistry): void {
  registry.register(createDuplicateLiterals213Pass());
  registry.register(createStringConcealing213Pass());
  registry.register(createGlobalConcealing213Pass());
  registry.register(createObjectExtraction213Pass());
  registry.register(createVariableMasking213Pass());
  registry.register(createDispatcher213Pass());
  registry.register(createControlFlowFlattening213Pass());
  registry.register(createCffWrapperModelPass());
  registry.register(createCffBody213Pass());
  registry.register(createCffTwiceBody213Pass());
  registry.register(createCffExportAliasesPass());
  registry.register(createCalculator213Pass());
  registry.register(createConstantFoldPass());
}
