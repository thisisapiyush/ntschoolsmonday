import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createJiraClient, NotAuthorisedError } from "../src/jiraClient.js";
import { FileTokenStore } from "../src/tokenStore.js";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

function tempPath(): string {
  return join(tmpdir(), `tokens-${randomBytes(4).toString("hex")}.json`);
}

describe("JiraClient", () => {
  describe("not authorised", () => {
    it("throws NotAuthorisedError when no tokens exist", async () => {
      const store = new FileTokenStore(tempPath());
      const client = createJiraClient({
        clientId: "test",
        clientSecret: "secret",
        tokenStore: store,
      });

      await expect(client.getAccessToken()).rejects.toThrow(
        NotAuthorisedError
      );
    });
  });

  describe("token refresh", () => {
    let tokenPath: string;
    let store: FileTokenStore;

    beforeEach(() => {
      tokenPath = tempPath();
      store = new FileTokenStore(tokenPath);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      try {
        await unlink(tokenPath);
      } catch {
        /* noop */
      }
    });

    it("persists new refresh token after rotation", async () => {
      await store.save({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 60_000,
        cloudId: "cloud-123",
        siteUrl: "https://test.atlassian.net",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
            scope: "read:jira-work",
            token_type: "Bearer",
          }),
        })
      );

      const client = createJiraClient({
        clientId: "test",
        clientSecret: "secret",
        tokenStore: store,
      });

      const result = await client.getAccessToken();
      expect(result.accessToken).toBe("new-access");

      const saved = await store.load();
      expect(saved?.refreshToken).toBe("new-refresh");
      expect(saved?.accessToken).toBe("new-access");
    });

    it("old refresh token is replaced", async () => {
      await store.save({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 60_000,
        cloudId: "cloud-123",
        siteUrl: "https://test.atlassian.net",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
            scope: "read:jira-work",
            token_type: "Bearer",
          }),
        })
      );

      const client = createJiraClient({
        clientId: "test",
        clientSecret: "secret",
        tokenStore: store,
      });

      await client.getAccessToken();
      const saved = await store.load();
      expect(saved?.refreshToken).not.toBe("old-refresh");
      expect(saved?.refreshToken).toBe("rotated-refresh");
    });

    it("clears tokens on refresh failure (revoked grant)", async () => {
      await store.save({
        accessToken: "old-access",
        refreshToken: "revoked-refresh",
        expiresAt: Date.now() + 60_000,
        cloudId: "cloud-123",
        siteUrl: "https://test.atlassian.net",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: false,
          status: 400,
        })
      );

      const client = createJiraClient({
        clientId: "test",
        clientSecret: "secret",
        tokenStore: store,
      });

      await expect(client.getAccessToken()).rejects.toThrow(
        NotAuthorisedError
      );
      expect(await store.load()).toBeNull();
    });

    it("skips refresh when token is not expiring soon", async () => {
      await store.save({
        accessToken: "valid-access",
        refreshToken: "valid-refresh",
        expiresAt: Date.now() + 30 * 60 * 1000,
        cloudId: "cloud-123",
        siteUrl: "https://test.atlassian.net",
      });

      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const client = createJiraClient({
        clientId: "test",
        clientSecret: "secret",
        tokenStore: store,
      });

      const result = await client.getAccessToken();
      expect(result.accessToken).toBe("valid-access");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
