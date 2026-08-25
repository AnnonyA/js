import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));

it("recovers add3, twice, and scenario from the second captured 2.1.3 CFF regression", async () => {
  const obfuscated = readFileSync(
    resolve(testDir, "../fixtures/2.1.3/controlFlowFlattening-regression2/obfuscated.js"),
    "utf8",
  );

  const result = await decompile(obfuscated);
  const bodies = result.report.recovery.cffBodies as Array<{
    exportName: string;
    reconstructed: boolean;
  }> | undefined;

  expect(
    bodies?.slice().sort((a, b) => a.exportName.localeCompare(b.exportName)),
  ).toEqual([
    { exportName: "add3", reconstructed: true },
    { exportName: "scenario", reconstructed: true },
    { exportName: "twice", reconstructed: true },
  ]);
});
