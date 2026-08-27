import { describe, it, expect } from "vitest";
import { parseSchoolName } from "../src/siteResolver.js";

describe("parseSchoolName", () => {
  it("extracts school name after the last separator", () => {
    expect(parseSchoolName("Install satellite link - Maningrida College")).toBe(
      "Maningrida College"
    );
  });

  it("handles multiple separators by taking the last", () => {
    expect(
      parseSchoolName("Phase 2 - Install cabling - Casuarina Senior College")
    ).toBe("Casuarina Senior College");
  });

  it("returns null when no separator exists", () => {
    expect(parseSchoolName("General maintenance task")).toBeNull();
  });

  it("returns null when separator is at the end with no name", () => {
    expect(parseSchoolName("Some task - ")).toBeNull();
  });

  it("trims whitespace from the school name", () => {
    expect(parseSchoolName("Task -  Nightcliff Primary School  ")).toBe(
      "Nightcliff Primary School"
    );
  });

  it("handles separator without surrounding spaces", () => {
    expect(parseSchoolName("Task-School")).toBeNull();
  });

  it("requires space-hyphen-space separator", () => {
    expect(parseSchoolName("Install link - Darwin High School")).toBe(
      "Darwin High School"
    );
  });
});
