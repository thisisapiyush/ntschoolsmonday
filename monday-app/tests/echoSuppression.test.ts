import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEchoStore } from "../src/echoSuppression.js";
import type { EchoStorage } from "../src/echoSuppression.js";

function makeMemoryStorage(): EchoStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
  };
}

describe("echoSuppression", () => {
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    storage = makeMemoryStorage();
  });

  it("returns false when no marker exists", async () => {
    const store = createEchoStore({ storage, windowMs: 60000 });
    const result = await store.check("NTSR-1", "status", "In Progress");
    expect(result).toBe(false);
  });

  it("returns true when a matching marker exists within window", async () => {
    const store = createEchoStore({ storage, windowMs: 60000 });
    await store.record("NTSR-1", "status", "In Progress");
    const result = await store.check("NTSR-1", "status", "In Progress");
    expect(result).toBe(true);
  });

  it("returns false for a different status value", async () => {
    const store = createEchoStore({ storage, windowMs: 60000 });
    await store.record("NTSR-1", "status", "In Progress");
    const result = await store.check("NTSR-1", "status", "Done");
    expect(result).toBe(false);
  });

  it("returns false for a different Jira key", async () => {
    const store = createEchoStore({ storage, windowMs: 60000 });
    await store.record("NTSR-1", "status", "In Progress");
    const result = await store.check("NTSR-2", "status", "In Progress");
    expect(result).toBe(false);
  });

  it("returns false after the window expires", async () => {
    const store = createEchoStore({ storage, windowMs: 100 });
    await store.record("NTSR-1", "status", "Done");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
    const result = await store.check("NTSR-1", "status", "Done");
    expect(result).toBe(false);
    vi.restoreAllMocks();
  });

  it("prunes expired markers on record", async () => {
    const store = createEchoStore({ storage, windowMs: 100 });
    await store.record("NTSR-1", "status", "To Do");

    const originalNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 200);
    await store.record("NTSR-2", "status", "Done");
    vi.restoreAllMocks();

    const raw = JSON.parse(storage.data.get("echo_markers") ?? "{}");
    const keys = Object.keys(raw);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("NTSR-2:status:Done");
  });

  it("builds marker key from jiraKey, field, and value", () => {
    const store = createEchoStore({ storage, windowMs: 60000 });
    expect(store.markerKey("NTSR-42", "status", "In Progress")).toBe(
      "NTSR-42:status:In Progress"
    );
  });
});
