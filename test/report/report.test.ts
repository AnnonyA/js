import { expect, it } from "vitest";
import { createEmptyReport } from "../../src/report/report.js";

it("creates a stable formatVersion 1 report", () => {
  const report = createEmptyReport();
  expect(report.formatVersion).toBe(1);
  expect(report.passes).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(report.errors).toEqual([]);
});
