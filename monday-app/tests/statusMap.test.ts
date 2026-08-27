import { describe, it, expect } from "vitest";
import { jiraStatusToMonday, mondayStatusToJira } from "../src/statusMap.js";

describe("jiraStatusToMonday", () => {
  it("maps To Do to Backlog", () => {
    expect(jiraStatusToMonday("To Do")).toBe("Backlog");
  });

  it("maps In Progress to In progress", () => {
    expect(jiraStatusToMonday("In Progress")).toBe("In progress");
  });

  it("maps In Review to In progress", () => {
    expect(jiraStatusToMonday("In Review")).toBe("In progress");
  });

  it("maps Done to Done", () => {
    expect(jiraStatusToMonday("Done")).toBe("Done");
  });

  it("returns undefined for unmapped status", () => {
    expect(jiraStatusToMonday("Cancelled")).toBeUndefined();
  });
});

describe("mondayStatusToJira", () => {
  it("maps Backlog to To Do", () => {
    expect(mondayStatusToJira("Backlog")).toBe("To Do");
  });

  it("maps In progress to In Progress (not In Review)", () => {
    expect(mondayStatusToJira("In progress")).toBe("In Progress");
  });

  it("maps Done to Done", () => {
    expect(mondayStatusToJira("Done")).toBe("Done");
  });

  it("returns undefined for unmapped status", () => {
    expect(mondayStatusToJira("On hold")).toBeUndefined();
  });
});
