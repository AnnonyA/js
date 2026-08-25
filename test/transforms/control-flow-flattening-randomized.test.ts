import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";
import { obfuscate213 } from "../helpers/jsconfuser213.js";

const testDir = dirname(fileURLToPath(import.meta.url));

function sourceFixture(): string {
  return readFileSync(
    resolve(testDir, "../fixtures/2.1.3/controlFlowFlattening/source.js"),
    "utf8",
  );
}

it("recovers CFF bodies across fresh 2.1.3 randomizations without golden entry sums", async () => {
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const obfuscated = await obfuscate213(sourceFixture(), {
      controlFlowFlattening: true,
      renameGlobals: false,
      renameLabels: false,
    });
    const result = await decompile(obfuscated);

    const wrappers = result.report.recovery.cffWrappers as Array<{
      exportName: string;
      entrySum: number;
    }>;
    expect(wrappers).toHaveLength(3);

    const randomizedSums = Object.fromEntries(
      wrappers.map((wrapper) => [wrapper.exportName, wrapper.entrySum]),
    );
    expect(randomizedSums).not.toEqual({
      add3: -750,
      scenario: -23,
      twice: -857,
    });

    const bodies = result.report.recovery.cffBodies as Array<{
      exportName: string;
      reconstructed: boolean;
    }> | undefined;
    const sortedBodies = bodies
      ?.slice()
      .sort((a, b) => a.exportName.localeCompare(b.exportName));
    const expectedBodies = [
      { exportName: "add3", reconstructed: true },
      { exportName: "scenario", reconstructed: true },
      { exportName: "twice", reconstructed: true },
    ];

    if (JSON.stringify(sortedBodies) !== JSON.stringify(expectedBodies)) {
      console.error(
        "RANDOMIZED_CFF_FAILURE",
        JSON.stringify({
          iteration,
          wrappers,
          passes: result.report.passes,
          recovery: result.report.recovery,
        }),
      );
      console.error("RANDOMIZED_CFF_SOURCE", obfuscated);
    }

    expect(sortedBodies).toEqual(expectedBodies);
  }
}, 60_000);
