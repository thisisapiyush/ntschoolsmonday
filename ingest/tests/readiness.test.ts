import { describe, it, expect } from "vitest";
import { readinessScore } from "../src/readiness.js";

describe("readinessScore", () => {
  it("returns 0 when all inputs are Unknown/Not started", () => {
    expect(readinessScore("Unknown", "Unknown", "Not started")).toBe(0);
  });

  it("returns 40 for power ready Yes only", () => {
    expect(readinessScore("Yes", "Unknown", "Not started")).toBe(40);
  });

  it("returns 40 for comms ready Yes only", () => {
    expect(readinessScore("Unknown", "Yes", "Not started")).toBe(40);
  });

  it("returns 80 for both power and comms Yes, site not complete", () => {
    expect(readinessScore("Yes", "Yes", "Not started")).toBe(80);
    expect(readinessScore("Yes", "Yes", "In progress")).toBe(80);
  });

  it("returns 100 when all conditions are met", () => {
    expect(readinessScore("Yes", "Yes", "Complete")).toBe(100);
  });

  it("returns 20 for site complete only", () => {
    expect(readinessScore("Unknown", "Unknown", "Complete")).toBe(20);
  });

  it("returns 60 for power Yes and site complete", () => {
    expect(readinessScore("Yes", "Unknown", "Complete")).toBe(60);
  });

  it("returns 0 for No values", () => {
    expect(readinessScore("No", "No", "Blocked")).toBe(0);
  });
});
