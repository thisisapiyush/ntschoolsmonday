import { describe, it, expect, vi } from "vitest";
import { createEchoStore } from "../src/echoSuppression.js";
import type { EchoStorage } from "../src/echoSuppression.js";

function makeMemoryStorage(): EchoStorage {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
  };
}

describe("loop prevention: full round trip", () => {
  it("monday-to-jira echo is suppressed by Phase 5", async () => {
    const storage = makeMemoryStorage();
    const echoStore = createEchoStore({ storage, windowMs: 60000 });

    // Step 1: action block transitions Jira to "In Progress" and records marker
    await echoStore.record("NTSR-42", "status", "In Progress");

    // Step 2: Jira webhook fires, Phase 5 checks echo before writing monday status
    const suppressed = await echoStore.check(
      "NTSR-42",
      "status",
      "In Progress"
    );
    expect(suppressed).toBe(true);
    // Phase 5 skips the monday status write. Loop stopped.
  });

  it("jira-to-monday echo is suppressed by action block", async () => {
    const storage = makeMemoryStorage();
    const echoStore = createEchoStore({ storage, windowMs: 60000 });

    // Step 1: Phase 5 writes monday status from Jira "Done" and records marker
    await echoStore.record("NTSR-42", "status", "Done");

    // Step 2: monday workflow fires, action block checks echo before transitioning
    const suppressed = await echoStore.check("NTSR-42", "status", "Done");
    expect(suppressed).toBe(true);
    // Action block skips the Jira transition. Loop stopped.
  });

  it("lossy mapping (On hold -> To Do) is suppressed correctly", async () => {
    const storage = makeMemoryStorage();
    const echoStore = createEchoStore({ storage, windowMs: 60000 });

    // Step 1: monday user sets "On hold", action maps to Jira "To Do", records marker
    await echoStore.record("NTSR-42", "status", "To Do");

    // Step 2: Jira webhook fires with status "To Do"
    // Phase 5 would map "To Do" -> monday "Backlog" (different from original "On hold")
    // But the echo marker is keyed on Jira status, so it matches
    const suppressed = await echoStore.check("NTSR-42", "status", "To Do");
    expect(suppressed).toBe(true);
    // Phase 5 skips. Monday item stays at "On hold", not overwritten with "Backlog".
  });

  it("genuine change after window expiry is NOT suppressed", async () => {
    const storage = makeMemoryStorage();
    const echoStore = createEchoStore({ storage, windowMs: 100 });

    // Integration sets status
    await echoStore.record("NTSR-42", "status", "In Progress");

    // 200ms later, user makes the same change again
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
    const suppressed = await echoStore.check(
      "NTSR-42",
      "status",
      "In Progress"
    );
    expect(suppressed).toBe(false);
    vi.restoreAllMocks();
    // Genuine change is processed. Not dropped.
  });

  it("different status is NOT suppressed even within window", async () => {
    const storage = makeMemoryStorage();
    const echoStore = createEchoStore({ storage, windowMs: 60000 });

    // Integration records marker for "In Progress"
    await echoStore.record("NTSR-42", "status", "In Progress");

    // User changes to "Done" (different status)
    const suppressed = await echoStore.check("NTSR-42", "status", "Done");
    expect(suppressed).toBe(false);
    // Different status is processed normally.
  });

  it("different issue is NOT suppressed even within window", async () => {
    const storage = makeMemoryStorage();
    const echoStore = createEchoStore({ storage, windowMs: 60000 });

    // Marker for NTSR-42
    await echoStore.record("NTSR-42", "status", "In Progress");

    // Event for NTSR-43
    const suppressed = await echoStore.check(
      "NTSR-43",
      "status",
      "In Progress"
    );
    expect(suppressed).toBe(false);
  });

  it("concurrent markers for multiple issues coexist", async () => {
    const storage = makeMemoryStorage();
    const echoStore = createEchoStore({ storage, windowMs: 60000 });

    await echoStore.record("NTSR-1", "status", "In Progress");
    await echoStore.record("NTSR-2", "status", "Done");

    expect(await echoStore.check("NTSR-1", "status", "In Progress")).toBe(
      true
    );
    expect(await echoStore.check("NTSR-2", "status", "Done")).toBe(true);
    expect(await echoStore.check("NTSR-1", "status", "Done")).toBe(false);
    expect(await echoStore.check("NTSR-2", "status", "In Progress")).toBe(
      false
    );
  });
});
