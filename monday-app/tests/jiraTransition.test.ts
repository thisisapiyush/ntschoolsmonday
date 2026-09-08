import { describe, it, expect, vi } from "vitest";
import { transitionIssue } from "../src/jiraTransition.js";

function makeMockJira(transitions: Array<{ id: string; name: string; toName: string }>) {
  const postCalls: Array<{ path: string; body: unknown }> = [];
  return {
    postCalls,
    get: vi.fn().mockResolvedValue({
      transitions: transitions.map((t) => ({
        id: t.id,
        name: t.name,
        to: { name: t.toName },
      })),
    }),
    post: vi.fn().mockResolvedValue({ id: "comment-1" }),
    postNoContent: vi.fn().mockImplementation(async (path: string, body: unknown) => {
      postCalls.push({ path, body });
    }),
    getAccessToken: vi.fn(),
  };
}

describe("transitionIssue", () => {
  it("transitions when a matching target status exists", async () => {
    const jira = makeMockJira([
      { id: "11", name: "Start Progress", toName: "In Progress" },
      { id: "21", name: "Mark Done", toName: "Done" },
    ]);

    const result = await transitionIssue(jira, "NTSR-1", "In Progress");

    expect(result.kind).toBe("transitioned");
    if (result.kind === "transitioned") {
      expect(result.transitionId).toBe("11");
      expect(result.transitionName).toBe("Start Progress");
    }
    expect(jira.postNoContent).toHaveBeenCalledWith(
      "issue/NTSR-1/transitions",
      { transition: { id: "11" } }
    );
  });

  it("returns no_matching_transition when target is unavailable", async () => {
    const jira = makeMockJira([
      { id: "11", name: "Start Progress", toName: "In Progress" },
    ]);

    const result = await transitionIssue(jira, "NTSR-1", "Done");

    expect(result.kind).toBe("no_matching_transition");
    if (result.kind === "no_matching_transition") {
      expect(result.availableTargets).toEqual(["In Progress"]);
    }
    expect(jira.postNoContent).not.toHaveBeenCalled();
  });

  it("matches on to.name not transition name", async () => {
    const jira = makeMockJira([
      { id: "31", name: "Reopen", toName: "To Do" },
    ]);

    const result = await transitionIssue(jira, "NTSR-1", "To Do");

    expect(result.kind).toBe("transitioned");
    if (result.kind === "transitioned") {
      expect(result.transitionName).toBe("Reopen");
    }
  });

  it("uses case-sensitive matching", async () => {
    const jira = makeMockJira([
      { id: "11", name: "Start", toName: "In Progress" },
    ]);

    const result = await transitionIssue(jira, "NTSR-1", "in progress");
    expect(result.kind).toBe("no_matching_transition");
  });
});
