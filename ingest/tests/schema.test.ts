import { describe, it, expect } from "vitest";
import {
  resolveLabel,
  resolveRegionLabels,
  validateCodeControlledLabels,
  type StatusColumnId,
} from "../src/schema.js";
import type { LabelMap } from "../src/types.js";

function buildSchema(
  entries: Array<[StatusColumnId, Record<string, number>]>
): Map<StatusColumnId, LabelMap> {
  const schema = new Map<StatusColumnId, LabelMap>();
  for (const [colId, labels] of entries) {
    const labelMap: LabelMap = new Map(Object.entries(labels));
    schema.set(colId, labelMap);
  }
  return schema;
}

describe("resolveLabel", () => {
  const schema = buildSchema([
    ["color_mm63hg85", { Urban: 0, Regional: 1, Remote: 2, "Very Remote": 3 }],
  ]);

  it("returns the correct index for a known label", () => {
    expect(resolveLabel(schema, "color_mm63hg85", "Urban")).toBe(0);
    expect(resolveLabel(schema, "color_mm63hg85", "Very Remote")).toBe(3);
  });

  it("throws for an unknown label", () => {
    expect(() =>
      resolveLabel(schema, "color_mm63hg85", "Outer Space")
    ).toThrow(/Label "Outer Space" not found in column color_mm63hg85/);
  });

  it("throws for an unknown column", () => {
    expect(() =>
      resolveLabel(schema, "color_mm64cjvv", "Not started")
    ).toThrow(/No label map loaded for column/);
  });
});

describe("resolveRegionLabels", () => {
  const schema = buildSchema([
    [
      "color_mm63v03v",
      {
        "Alice Springs": 0,
        Barkly: 1,
        "Big Rivers": 2,
        Central: 3,
        Darwin: 4,
        "East Arnhem": 5,
        "Top End": 6,
      },
    ],
  ]);

  it("resolves known regions", () => {
    const { resolved, unmapped } = resolveRegionLabels(schema, [
      "Darwin",
      "Barkly",
      "Darwin",
    ]);
    expect(resolved.get("Darwin")).toBe(4);
    expect(resolved.get("Barkly")).toBe(1);
    expect(unmapped).toEqual([]);
  });

  it("reports unmapped regions without throwing", () => {
    const { resolved, unmapped } = resolveRegionLabels(schema, [
      "Darwin",
      "n/a",
      "Imaginary",
    ]);
    expect(resolved.get("Darwin")).toBe(4);
    expect(unmapped).toContain("n/a");
    expect(unmapped).toContain("Imaginary");
  });

  it("deduplicates region values", () => {
    const { unmapped } = resolveRegionLabels(schema, ["n/a", "n/a", "n/a"]);
    expect(unmapped).toEqual(["n/a"]);
  });
});

describe("validateCodeControlledLabels", () => {
  it("passes when all required labels exist", () => {
    const schema = buildSchema([
      [
        "color_mm63hg85",
        { Urban: 0, Regional: 1, Remote: 2, "Very Remote": 3 },
      ],
      ["color_mm64cjvv", { "Not started": 0, "In progress": 1 }],
      ["color_mm643hp0", { Unknown: 0, Yes: 1, No: 2 }],
      ["color_mm64ty9d", { Unknown: 0, Yes: 1, No: 2 }],
    ]);

    expect(() =>
      validateCodeControlledLabels(
        schema,
        new Map<StatusColumnId, string[]>([
          ["color_mm63hg85", ["Urban", "Regional", "Remote", "Very Remote"]],
          ["color_mm64cjvv", ["Not started"]],
          ["color_mm643hp0", ["Unknown"]],
          ["color_mm64ty9d", ["Unknown"]],
        ])
      )
    ).not.toThrow();
  });

  it("throws when a required label is missing", () => {
    const schema = buildSchema([
      ["color_mm63hg85", { Urban: 0, Regional: 1 }],
      ["color_mm64cjvv", { "Not started": 0 }],
      ["color_mm643hp0", { Unknown: 0 }],
      ["color_mm64ty9d", { Unknown: 0 }],
    ]);

    expect(() =>
      validateCodeControlledLabels(
        schema,
        new Map<StatusColumnId, string[]>([
          ["color_mm63hg85", ["Urban", "Regional", "Remote", "Very Remote"]],
          ["color_mm64cjvv", ["Not started"]],
          ["color_mm643hp0", ["Unknown"]],
          ["color_mm64ty9d", ["Unknown"]],
        ])
      )
    ).toThrow(/missing label "Remote"/);
  });
});
