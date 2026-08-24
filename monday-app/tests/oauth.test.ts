import { describe, it, expect } from "vitest";
import {
  generateState,
  isTokenExpiringSoon,
  buildAuthorizeUrl,
} from "../src/oauth.js";

describe("generateState", () => {
  it("produces a 64-character hex string", () => {
    const state = generateState();
    expect(state).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces unique values", () => {
    const states = new Set(Array.from({ length: 20 }, () => generateState()));
    expect(states.size).toBe(20);
  });
});

describe("isTokenExpiringSoon", () => {
  it("returns false when token expires in more than 5 minutes", () => {
    const expiresAt = Date.now() + 6 * 60 * 1000;
    expect(isTokenExpiringSoon(expiresAt)).toBe(false);
  });

  it("returns true when token expires in less than 5 minutes", () => {
    const expiresAt = Date.now() + 4 * 60 * 1000;
    expect(isTokenExpiringSoon(expiresAt)).toBe(true);
  });

  it("returns true when token is already expired", () => {
    const expiresAt = Date.now() - 1000;
    expect(isTokenExpiringSoon(expiresAt)).toBe(true);
  });

  it("returns true at exactly 5 minutes", () => {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    expect(isTokenExpiringSoon(expiresAt)).toBe(true);
  });
});

describe("buildAuthorizeUrl", () => {
  const config = {
    clientId: "test-client-id",
    redirectUri: "http://localhost:8080/oauth/callback",
  };

  it("targets the Atlassian authorize endpoint", () => {
    const { url } = buildAuthorizeUrl(config);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://auth.atlassian.com/authorize"
    );
  });

  it("includes all required OAuth parameters", () => {
    const { url, state } = buildAuthorizeUrl(config);
    const params = new URL(url).searchParams;

    expect(params.get("audience")).toBe("api.atlassian.com");
    expect(params.get("client_id")).toBe("test-client-id");
    expect(params.get("redirect_uri")).toBe(
      "http://localhost:8080/oauth/callback"
    );
    expect(params.get("response_type")).toBe("code");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("state")).toBe(state);
  });

  it("requests offline_access in scope", () => {
    const { url } = buildAuthorizeUrl(config);
    const scope = new URL(url).searchParams.get("scope") ?? "";
    expect(scope).toContain("offline_access");
    expect(scope).toContain("read:jira-work");
    expect(scope).toContain("write:jira-work");
    expect(scope).toContain("read:jira-user");
  });

  it("returns a state with a future expiry", () => {
    const before = Date.now();
    const { state, expiresAt } = buildAuthorizeUrl(config);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBeGreaterThan(before);
  });
});
