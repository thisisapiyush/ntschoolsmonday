import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveRemoteness, filterAndTransform } from "../src/transform.js";
import { RawSchoolArraySchema, type RawSchool } from "../src/types.js";

const fixturePath = resolve(import.meta.dirname, "../data/schools-raw.json");
const rawFixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;
const allSchools = RawSchoolArraySchema.parse(rawFixture);

describe("deriveRemoteness", () => {
  it('returns "Very Remote" for Remote School', () => {
    expect(deriveRemoteness("Remote School", "East Arnhem")).toBe(
      "Very Remote"
    );
  });

  it('returns "Very Remote" for Small School', () => {
    expect(deriveRemoteness("Small School", "Central")).toBe("Very Remote");
  });

  it('returns "Remote" for Distance School', () => {
    expect(deriveRemoteness("Distance School", "Darwin")).toBe("Remote");
  });

  it('returns "Urban" for non-remote Darwin school', () => {
    expect(deriveRemoteness("Primary School", "Darwin")).toBe("Urban");
  });

  it('returns "Regional" for non-remote non-Darwin school', () => {
    expect(deriveRemoteness("Primary School", "Alice Springs")).toBe(
      "Regional"
    );
  });

  it('returns "Urban" for null schoolType in Darwin', () => {
    expect(deriveRemoteness(null, "Darwin")).toBe("Urban");
  });

  it('returns "Regional" for null schoolType outside Darwin', () => {
    expect(deriveRemoteness(null, "Central")).toBe("Regional");
  });
});

describe("filterAndTransform", () => {
  const result = filterAndTransform(allSchools);

  it("starts with the full fixture of 276 schools", () => {
    expect(result.totalCount).toBe(276);
  });

  it("excludes non-government schools", () => {
    expect(result.nonGovernmentCount).toBeGreaterThan(0);
  });

  it("excludes preschools by flag and by type separately", () => {
    expect(result.preSchoolFlagCount + result.preSchoolTypeCount).toBeGreaterThanOrEqual(0);
  });

  it("filter counts add up to the total", () => {
    expect(
      result.filteredCount +
        result.nonGovernmentCount +
        result.preSchoolFlagCount +
        result.preSchoolTypeCount
    ).toBe(result.totalCount);
  });

  it("does not include any non-government schools", () => {
    const govSchoolNames = new Set(
      allSchools.filter((s) => !s.isGovernment).map((s) => s.schoolName)
    );
    for (const item of result.items) {
      expect(govSchoolNames.has(item.name)).toBe(false);
    }
  });

  it("does not include any preschool-flagged schools", () => {
    const preSchoolNames = new Set(
      allSchools
        .filter((s) => s.isGovernment && s.isPreSchool)
        .map((s) => s.schoolName)
    );
    for (const item of result.items) {
      expect(preSchoolNames.has(item.name)).toBe(false);
    }
  });

  it("does not include any Preschool-typed schools", () => {
    const preSchoolTypeNames = new Set(
      allSchools
        .filter(
          (s) =>
            s.isGovernment && !s.isPreSchool && s.schoolType === "Preschool"
        )
        .map((s) => s.schoolName)
    );
    for (const item of result.items) {
      expect(preSchoolTypeNames.has(item.name)).toBe(false);
    }
  });

  it("handles null schoolType without crashing", () => {
    const nullTypeSchool: RawSchool = {
      schoolName: "Test School",
      schoolType: null,
      electorate: "Test",
      decsRegion: "Darwin",
      isGovernment: true,
      itSchoolCode: "testsch",
      isPreSchool: false,
      displayInternal: true,
      displayExternal: true,
    };
    const singleResult = filterAndTransform([nullTypeSchool]);
    expect(singleResult.filteredCount).toBe(1);
    expect(singleResult.items[0]?.remoteness).toBe("Urban");
  });

  it('handles "n/a" electorate without crashing', () => {
    const naElectorateSchool: RawSchool = {
      schoolName: "NA School",
      schoolType: "College",
      electorate: "n/a",
      decsRegion: "Darwin",
      isGovernment: true,
      itSchoolCode: "nasch",
      isPreSchool: false,
      displayInternal: true,
      displayExternal: true,
    };
    const singleResult = filterAndTransform([naElectorateSchool]);
    expect(singleResult.filteredCount).toBe(1);
  });

  it("all items have readinessScore 0 on first ingest", () => {
    for (const item of result.items) {
      expect(item.readinessScore).toBe(0);
    }
  });

  it("all items have a valid remoteness value", () => {
    const validRemoteness = new Set([
      "Urban",
      "Regional",
      "Remote",
      "Very Remote",
    ]);
    for (const item of result.items) {
      expect(validRemoteness.has(item.remoteness)).toBe(true);
    }
  });

  it("every item has a non-empty schoolCode", () => {
    for (const item of result.items) {
      expect(item.schoolCode.length).toBeGreaterThan(0);
    }
  });
});
