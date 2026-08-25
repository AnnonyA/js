import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { decompile } from "../../src/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(testDir, "../fixtures/plain/input.js");

it("preserves behavior in both Phase 1 outputs", async () => {
  const source = readFileSync(fixturePath, "utf8");
  const result = await decompile(source);
  const dir = mkdtempSync(join(tmpdir(), "jsconfuser-e2e-"));
  const safePath = join(dir, "safe.mjs");
  const cleanPath = join(dir, "clean.mjs");
  writeFileSync(safePath, result.safeCode);
  writeFileSync(cleanPath, result.cleanCode);

  const safeModule = await import(`${pathToFileURL(safePath).href}?safe=${Date.now()}`);
  const cleanModule = await import(`${pathToFileURL(cleanPath).href}?clean=${Date.now()}`);

  expect(safeModule.add(2, 3)).toBe(5);
  expect(cleanModule.add(2, 3)).toBe(5);
  expect(result.report.validation.safe.syntax).toBe(true);
  expect(result.report.validation.clean.syntax).toBe(true);
});
