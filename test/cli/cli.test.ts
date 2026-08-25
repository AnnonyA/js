import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { decompileFile } from "../../src/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const cliPath = join(repoRoot, "dist/cli/cli.js");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

beforeAll(() => {
  execFileSync(npmCommand, ["run", "build"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
});

it("decompileFile writes deterministic safe, clean, and report files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsconfuser-file-api-"));
  const inputPath = join(dir, "input.js");
  const outputDirectory = join(dir, "decompiled");
  writeFileSync(inputPath, "export const answer = 42;\n");

  const result = await decompileFile(inputPath, { outputDirectory });

  expect(result.safeCode).toContain("answer");
  expect(existsSync(join(outputDirectory, "input.safe.js"))).toBe(true);
  expect(existsSync(join(outputDirectory, "input.clean.js"))).toBe(true);
  expect(existsSync(join(outputDirectory, "input.report.json"))).toBe(true);
  expect(readFileSync(inputPath, "utf8")).toBe("export const answer = 42;\n");
});

it("the built CLI writes defaults and analyze-only writes only a report", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsconfuser-cli-"));
  const inputPath = join(dir, "input.js");
  writeFileSync(inputPath, "export const answer = 42;\n");

  const normal = spawnSync(process.execPath, [cliPath, inputPath], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(normal.status, normal.stderr).toBe(0);
  expect(existsSync(join(dir, "decompiled", "input.safe.js"))).toBe(true);
  expect(existsSync(join(dir, "decompiled", "input.clean.js"))).toBe(true);
  expect(existsSync(join(dir, "decompiled", "input.report.json"))).toBe(true);

  const analysisDirectory = join(dir, "analysis");
  const analysis = spawnSync(
    process.execPath,
    [cliPath, inputPath, "--analyze-only", "--out", analysisDirectory],
    { cwd: dir, encoding: "utf8" },
  );
  expect(analysis.status, analysis.stderr).toBe(0);
  expect(existsSync(join(analysisDirectory, "input.report.json"))).toBe(true);
  expect(existsSync(join(analysisDirectory, "input.safe.js"))).toBe(false);
  expect(existsSync(join(analysisDirectory, "input.clean.js"))).toBe(false);
});
