import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  generate213Fixture,
  type JsConfuser213Options,
} from "../test/helpers/jsconfuser213.js";

const sourcePath = resolve(
  process.cwd(),
  "test/fixtures/2.1.3/sources/basic.js",
);
const source = await readFile(sourcePath, "utf8");

const baseline: JsConfuser213Options = {
  preset: false,
  renameLabels: false,
  renameGlobals: false,
  preserveFunctionLength: false,
};

const fixtures = {
  renameVariables: {
    ...baseline,
    renameVariables: true,
    renameGlobals: true,
  },
  calculator: {
    ...baseline,
    calculator: true,
  },
  stringConcealing: {
    ...baseline,
    stringConcealing: true,
  },
  globalConcealing: {
    ...baseline,
    globalConcealing: true,
  },
  variableMasking: {
    ...baseline,
    variableMasking: true,
  },
  dispatcher: {
    ...baseline,
    dispatcher: true,
  },
  controlFlowFlattening: {
    ...baseline,
    controlFlowFlattening: true,
  },
  opaquePredicates: {
    ...baseline,
    opaquePredicates: true,
  },
  deadCode: {
    ...baseline,
    deadCode: true,
  },
} satisfies Record<string, JsConfuser213Options>;

for (const [name, options] of Object.entries(fixtures)) {
  await generate213Fixture(name, source, options);
  process.stdout.write(`generated ${name}\n`);
}
