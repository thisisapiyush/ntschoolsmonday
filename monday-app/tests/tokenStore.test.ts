import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileTokenStore, FileStateStore } from "../src/tokenStore.js";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

function tempPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomBytes(4).toString("hex")}.json`);
}

describe("FileTokenStore", () => {
  let store: FileTokenStore;
  let filePath: string;

  beforeEach(() => {
    filePath = tempPath("tokens");
    store = new FileTokenStore(filePath);
  });

  afterEach(async () => {
    try {
      await unlink(filePath);
    } catch {
      /* noop */
    }
  });

  const testTokens = {
    accessToken: "access-123",
    refreshToken: "refresh-456",
    expiresAt: Date.now() + 3600000,
    cloudId: "cloud-789",
    siteUrl: "https://test.atlassian.net",
  };

  it("returns null when no tokens exist", async () => {
    expect(await store.load()).toBeNull();
  });

  it("round-trips save and load", async () => {
    await store.save(testTokens);
    const loaded = await store.load();
    expect(loaded).toEqual(testTokens);
  });

  it("overwrites on second save", async () => {
    await store.save(testTokens);
    const updated = { ...testTokens, accessToken: "new-access" };
    await store.save(updated);
    const loaded = await store.load();
    expect(loaded?.accessToken).toBe("new-access");
  });

  it("clears stored tokens", async () => {
    await store.save(testTokens);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("clear is safe when no file exists", async () => {
    await expect(store.clear()).resolves.not.toThrow();
  });
});

describe("FileStateStore", () => {
  let store: FileStateStore;
  let filePath: string;

  beforeEach(() => {
    filePath = tempPath("states");
    store = new FileStateStore(filePath);
  });

  afterEach(async () => {
    try {
      await unlink(filePath);
    } catch {
      /* noop */
    }
  });

  it("consumes a valid state", async () => {
    await store.save("test-state", Date.now() + 600_000);
    expect(await store.consume("test-state")).toBe(true);
  });

  it("rejects an unknown state", async () => {
    expect(await store.consume("unknown")).toBe(false);
  });

  it("state cannot be consumed twice", async () => {
    await store.save("once-only", Date.now() + 600_000);
    expect(await store.consume("once-only")).toBe(true);
    expect(await store.consume("once-only")).toBe(false);
  });

  it("rejects an expired state", async () => {
    await store.save("expired", Date.now() - 1000);
    expect(await store.consume("expired")).toBe(false);
  });

  it("multiple states coexist", async () => {
    await store.save("state-a", Date.now() + 600_000);
    await store.save("state-b", Date.now() + 600_000);
    expect(await store.consume("state-a")).toBe(true);
    expect(await store.consume("state-b")).toBe(true);
  });
});
